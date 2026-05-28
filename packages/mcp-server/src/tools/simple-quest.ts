import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';

/**
 * SimpleQuest (theripper93) integration.
 *
 * SimpleQuest stores each individual quest as a JournalEntryPage inside a
 * per-category JournalEntry ("Main Story", "Side Quests", "Completed", etc.),
 * all under a top-level "Quests" folder. Its UI reads from BOTH:
 *
 *   page.text.content                    →  <ul><li><p>objective</p></li>...</ul>
 *   page.flags["simple-quest"].checkboxes  →  { "<objectiveKey>": 0 | 1 }
 *   page.flags["simple-quest"].secret      →  { "<objectiveKey>": false | true }
 *   page.flags["simple-quest"].completed   →  whole-quest done
 *   page.flags["simple-quest"].completedSubquests → { "<questSlug>": true }
 *   page.flags["simple-quest"].lastUpdated →  epoch ms
 *
 * objectiveKey is the objective text with all whitespace stripped (e.g.
 * "Collect information about Doru" → "CollectinformationaboutDoru"). The
 * apostrophe and other punctuation are kept verbatim.
 *
 * questSlug is the quest name kebab-cased ("The Fate of Doru" → "the-fate-of-doru").
 */

export interface SimpleQuestToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

type Operation =
  | 'set-objectives'
  | 'add-objective'
  | 'remove-objective'
  | 'check-objective'
  | 'uncheck-objective'
  | 'mark-complete'
  | 'mark-incomplete'
  | 'rename';

const KNOWN_CATEGORIES = [
  'Main Story',
  'Side Quests',
  'Completed',
  'Failed',
  'Achievements',
  'Timeline',
  'Maps',
] as const;

function objectiveKey(text: string): string {
  return text.replace(/\s+/g, '');
}

function questSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function objectivesToHtml(objectives: string[]): string {
  if (objectives.length === 0) return '';
  const items = objectives.map((o) => `<li><p>${escapeHtml(o)}</p></li>`).join('');
  return `<ul>${items}</ul>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Parse SimpleQuest objective HTML back to a plain-text list. Tolerates the
 * common shapes: <ul><li><p>X</p></li></ul>, <ol>...</ol>, and bare <li>X</li>.
 */
function parseObjectives(html: string): string[] {
  if (!html) return [];
  // Match every <li>...</li> and strip inner tags.
  const items: string[] = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null) {
    const inner = m[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
    if (inner) items.push(decodeEntities(inner));
  }
  return items;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

export class SimpleQuestTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor(options: SimpleQuestToolsOptions) {
    this.foundryClient = options.foundryClient;
    this.logger = options.logger;
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'update-simple-quest',
        description:
          'Update a SimpleQuest (theripper93 module) quest journal entry by quest name. ' +
          'Writes both text.content (objective HTML) and flags["simple-quest"] (checkbox + ' +
          'completion state) so the SimpleQuest UI re-renders correctly. The "Quests" folder ' +
          'is searched across all categories (Main Story / Side Quests / Completed / Failed / ' +
          'custom). Pass `category` to disambiguate when the same quest name exists in multiple ' +
          'categories. Use this INSTEAD of update-quest-journal for SimpleQuest entries — ' +
          'update-quest-journal only writes text.content and the UI will not reflect changes.',
        inputSchema: {
          type: 'object',
          properties: {
            questName: {
              type: 'string',
              description: 'Exact quest name as it appears in SimpleQuest (e.g. "The Fate of Doru"). Case-insensitive.',
            },
            category: {
              type: 'string',
              description:
                'Optional category to scope the lookup ("Main Story", "Side Quests", "Completed", ' +
                '"Failed", "Achievements", or a custom category like "The Curse of Strahd"). Required ' +
                'only when the quest name is ambiguous across categories.',
            },
            operation: {
              type: 'string',
              enum: [
                'set-objectives',
                'add-objective',
                'remove-objective',
                'check-objective',
                'uncheck-objective',
                'mark-complete',
                'mark-incomplete',
                'rename',
              ],
              description:
                'Operation: set-objectives replaces the full list; add/remove-objective edit one ' +
                'entry; check/uncheck-objective toggle a checkbox; mark-complete/incomplete sets ' +
                'overall completion + all checkboxes; rename changes the quest title.',
            },
            objectives: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For set-objectives: the full list of objective strings, in display order. Each ' +
                'should be a single PLAYER-FACING ACTIONABLE step (verb-first: "Investigate the ' +
                'mansion", not "Discover the Burgomaster is dead"). 5-7 steps is the SimpleQuest ' +
                'sweet spot.',
            },
            secretObjectives: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For set-objectives: subset of `objectives` (verbatim match) to mark as secret ' +
                '(hidden from players in the SimpleQuest UI until the DM reveals them).',
            },
            objectiveText: {
              type: 'string',
              description:
                'For add/remove/check/uncheck-objective: the objective text. For check/uncheck, ' +
                'matches against current objectives case-insensitively; for add, the new objective ' +
                'is appended.',
            },
            secret: {
              type: 'boolean',
              description: 'For add-objective: mark the new objective as secret. Default false.',
            },
            newName: {
              type: 'string',
              description: 'For rename: the new quest title.',
            },
          },
          required: ['questName', 'operation'],
        },
      },
    ];
  }

  async handleUpdateSimpleQuest(args: any): Promise<any> {
    try {
      const schema = z
        .object({
          questName: z.string().min(1),
          category: z.string().optional(),
          operation: z.enum([
            'set-objectives',
            'add-objective',
            'remove-objective',
            'check-objective',
            'uncheck-objective',
            'mark-complete',
            'mark-incomplete',
            'rename',
          ]),
          objectives: z.array(z.string().min(1)).optional(),
          secretObjectives: z.array(z.string().min(1)).optional(),
          objectiveText: z.string().optional(),
          secret: z.boolean().optional(),
          newName: z.string().optional(),
        })
        .superRefine((data, ctx) => {
          const op = data.operation;
          if (op === 'set-objectives' && (!data.objectives || data.objectives.length === 0)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'set-objectives requires non-empty objectives[]' });
          }
          if ((op === 'add-objective' || op === 'remove-objective' || op === 'check-objective' || op === 'uncheck-objective') && !data.objectiveText) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${op} requires objectiveText` });
          }
          if (op === 'rename' && !data.newName) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'rename requires newName' });
          }
        });

      const req = schema.parse(args);

      // Locate the page
      const match = await this.findQuestPage(req.questName, req.category);

      // Read current state
      const current = await this.foundryClient.query('foundry-forge-mcp.getJournalPageContent', {
        journalId: match.journalId,
        pageId: match.pageId,
      });
      if (!current || current.error) {
        throw new Error(`Could not read current page: ${current?.error || 'no data'}`);
      }

      const currentObjectives = parseObjectives(current.content || '');
      const currentFlags = (current.flags && current.flags['simple-quest']) || {};
      const currentCheckboxes: Record<string, 0 | 1> = { ...(currentFlags.checkboxes || {}) };
      const currentSecret: Record<string, boolean> = { ...(currentFlags.secret || {}) };

      // Compute the patch
      let newObjectives = [...currentObjectives];
      let newCheckboxes = { ...currentCheckboxes };
      let newSecret = { ...currentSecret };
      let newCompleted = currentFlags.completed === true;
      let newName: string | undefined;

      switch (req.operation) {
        case 'set-objectives': {
          newObjectives = req.objectives!;
          newCheckboxes = {};
          newSecret = {};
          const secretSet = new Set((req.secretObjectives || []).map((s) => s));
          for (const o of newObjectives) {
            const k = objectiveKey(o);
            newCheckboxes[k] = 0;
            newSecret[k] = secretSet.has(o);
          }
          newCompleted = false;
          break;
        }
        case 'add-objective': {
          newObjectives.push(req.objectiveText!);
          const k = objectiveKey(req.objectiveText!);
          newCheckboxes[k] = 0;
          newSecret[k] = req.secret === true;
          newCompleted = false;
          break;
        }
        case 'remove-objective': {
          const idx = this.findObjectiveIndex(newObjectives, req.objectiveText!);
          if (idx === -1) throw new Error(`Objective not found on quest: "${req.objectiveText}"`);
          const removed = newObjectives.splice(idx, 1)[0]!;
          const k = objectiveKey(removed);
          delete newCheckboxes[k];
          delete newSecret[k];
          break;
        }
        case 'check-objective':
        case 'uncheck-objective': {
          const idx = this.findObjectiveIndex(newObjectives, req.objectiveText!);
          if (idx === -1) throw new Error(`Objective not found on quest: "${req.objectiveText}"`);
          const k = objectiveKey(newObjectives[idx]!);
          newCheckboxes[k] = req.operation === 'check-objective' ? 1 : 0;
          if (req.operation === 'check-objective') {
            const all = newObjectives.every((o) => newCheckboxes[objectiveKey(o)] === 1);
            if (all) newCompleted = true;
          } else {
            newCompleted = false;
          }
          break;
        }
        case 'mark-complete': {
          newObjectives.forEach((o) => (newCheckboxes[objectiveKey(o)] = 1));
          newCompleted = true;
          break;
        }
        case 'mark-incomplete': {
          newObjectives.forEach((o) => (newCheckboxes[objectiveKey(o)] = 0));
          newCompleted = false;
          break;
        }
        case 'rename': {
          newName = req.newName!;
          break;
        }
      }

      // Build the merged flags update. SimpleQuest's completedSubquests is
      // keyed by quest slug; track it in sync with `completed`.
      const slug = questSlug(req.operation === 'rename' ? newName! : match.questName);
      const completedSubquests = {
        ...(currentFlags.completedSubquests || {}),
        [slug]: newCompleted,
      };

      const flagsPatch: Record<string, any> = {
        'simple-quest': {
          ...currentFlags,
          checkboxes: newCheckboxes,
          secret: newSecret,
          completed: newCompleted,
          completedSubquests,
          lastUpdated: Date.now(),
        },
      };

      // Build the bridge call. Content only changes when objectives change.
      const objectivesChanged = req.operation !== 'rename';
      const updatePayload: any = {
        journalId: match.journalId,
        pageId: match.pageId,
        flags: flagsPatch,
      };
      if (objectivesChanged) {
        updatePayload.content = objectivesToHtml(newObjectives);
      }
      if (newName !== undefined) {
        updatePayload.pageName = newName;
      }

      const result = await this.foundryClient.query('foundry-forge-mcp.updateJournalContent', updatePayload);
      if (!result || result.error || result.success === false) {
        throw new Error(`Write failed: ${result?.error || 'unknown'}`);
      }

      return {
        success: true,
        questName: newName ?? match.questName,
        category: match.category,
        journalId: match.journalId,
        pageId: match.pageId,
        operation: req.operation,
        objectives: newObjectives,
        checkboxes: newCheckboxes,
        completed: newCompleted,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'update-simple-quest', 'simple-quest update');
    }
  }

  /**
   * Find the page matching a quest name. Searches the Quests folder; if a
   * `category` is provided, restricts to that JournalEntry. Throws on 0 or
   * 2+ matches.
   */
  private async findQuestPage(questName: string, category?: string): Promise<{
    questName: string;
    category: string;
    journalId: string;
    pageId: string;
  }> {
    const journals = await this.foundryClient.query('foundry-forge-mcp.listJournals', {
      folder: 'Quests',
    });
    if (!journals || journals.error) {
      throw new Error('Could not list Quests folder');
    }
    const list: any[] = Array.isArray(journals) ? journals : journals.items || [];
    const needle = questName.trim().toLowerCase();

    const matches: { journalId: string; pageId: string; pageName: string; category: string }[] = [];
    for (const j of list) {
      if (category && j.name?.toLowerCase() !== category.toLowerCase()) continue;
      for (const p of j.pages || []) {
        if ((p.name || '').toLowerCase() === needle) {
          matches.push({ journalId: j.id, pageId: p.id, pageName: p.name, category: j.name });
        }
      }
    }

    if (matches.length === 0) {
      const categoryHint = category ? ` in category "${category}"` : '';
      throw new Error(`No SimpleQuest page matching "${questName}"${categoryHint}.`);
    }
    if (matches.length > 1) {
      const cats = matches.map((m) => `"${m.category}"`).join(', ');
      throw new Error(
        `Quest name "${questName}" exists in multiple categories: ${cats}. Pass category= to disambiguate.`,
      );
    }
    const m = matches[0]!;
    return { questName: m.pageName, category: m.category, journalId: m.journalId, pageId: m.pageId };
  }

  private findObjectiveIndex(objectives: string[], text: string): number {
    const needle = text.trim().toLowerCase();
    return objectives.findIndex((o) => o.toLowerCase() === needle);
  }
}

// Keep the linter happy when KNOWN_CATEGORIES is exported for downstream tools.
export { KNOWN_CATEGORIES };
