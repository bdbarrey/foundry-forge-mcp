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
  // Strip whitespace AND dots/brackets — Foundry's Document.update() treats
  // dot-keys as nested data paths (so "St. Andral" → {St: {Andral: 0}}). The
  // real SimpleQuest data we observed only contains alphanumerics + apostrophe
  // ("DetermineDoru'sfate"), which suggests this is also TheRipper93's
  // approach. Apostrophes are Foundry-safe and preserved.
  return text.replace(/[\s.\[\]]+/g, '');
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

export interface QuestHeader {
  imageUrl: string;
  meta: { label: string; value: string }[];
  maskNumber: number;
}

/**
 * SimpleQuest header table — populated CoS Reloaded quests embed an image +
 * meta-fields block at the top of text.content as a <table>. The right cell
 * shows <strong>Label:</strong> Value pairs. The image gets a webkit-mask
 * for the ornate border (mask1.webp..mask5.webp).
 */
function buildHeaderTable(h: QuestHeader): string {
  const maskPath = `modules/simple-quest/assets/mask/mask${h.maskNumber}.webp`;
  const metaCell = h.meta.length
    ? h.meta
        .map((m) => `<p><strong>${escapeHtml(m.label)}: </strong>${escapeHtml(m.value)}</p>`)
        .join('')
    : '';
  return (
    `<table style="width:100%;border:none;background:transparent">` +
    `<tbody>` +
    `<tr style="background:transparent">` +
    `<td style="width:50%;padding:0;margin:0">` +
    `<img style="-webkit-mask-size:100% 100%;-webkit-mask-image:url('${maskPath}');object-fit:cover;border:none;border-radius:5px;width:100%;aspect-ratio:1/1" src="${h.imageUrl}" />` +
    `</td>` +
    `<td style="padding:2rem;font-size:1.5rem">${metaCell}</td>` +
    `</tr>` +
    `<tr style="background:transparent"><td colspan="2"><p></p></td></tr>` +
    `</tbody>` +
    `</table>`
  );
}

/**
 * Split current text.content into (header table HTML if present, objective
 * list HTML if present). Preserves the existing header byte-for-byte so we
 * never round-trip through buildHeaderTable when the caller hasn't asked to
 * change it.
 */
function splitQuestContent(html: string): { headerHtml: string; objectivesHtml: string } {
  if (!html) return { headerHtml: '', objectivesHtml: '' };
  // Match the FIRST top-level <table>...</table> as the header.
  const tableRe = /<table[^>]*>[\s\S]*?<\/table>/i;
  const m = html.match(tableRe);
  if (!m) return { headerHtml: '', objectivesHtml: html };
  const headerHtml = m[0];
  const remaining = html.slice(0, m.index!) + html.slice(m.index! + headerHtml.length);
  return { headerHtml, objectivesHtml: remaining.trim() };
}

function composeQuestContent(headerHtml: string, objectivesHtml: string): string {
  if (headerHtml && objectivesHtml) return `${headerHtml}${objectivesHtml}`;
  return headerHtml || objectivesHtml || '';
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
                'set-header',
                'clear-header',
                'move-to-category',
              ],
              description:
                'Operation: set-objectives replaces the full list; add/remove-objective edit one ' +
                'entry; check/uncheck-objective toggle a checkbox; mark-complete/incomplete sets ' +
                'overall completion + all checkboxes; rename changes the quest title; set-header ' +
                'sets/replaces the image + meta block at the top of the quest page; clear-header ' +
                'removes the image+meta block while leaving objectives intact; move-to-category ' +
                'moves the quest page to a different category JournalEntry (e.g. Main Story → ' +
                'Completed). The page gets a new pageId after the move.',
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
            headerImageUrl: {
              type: 'string',
              description:
                'For set-header (and optionally set-objectives): direct URL to the quest header ' +
                'image. Forge CDN URL (https://assets.forge-vtt.com/...) renders inline without ' +
                're-upload. Aspect ratio is forced to 1:1 by SimpleQuest, so 1024x1024 PNGs work best.',
            },
            headerMeta: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label', 'value'],
              },
              description:
                'For set-header (and optionally set-objectives): array of {label, value} pairs ' +
                'rendered as "<strong>Label:</strong> Value" in the right cell of the header. ' +
                'Common labels: Region, Government, Religion, Quest Giver, Reward.',
            },
            headerMaskNumber: {
              type: 'number',
              description:
                'For set-header (and optionally set-objectives): SimpleQuest mask number (1-5, ' +
                'default 4). Selects the ornate border style applied to the image.',
            },
            targetCategory: {
              type: 'string',
              description:
                'For move-to-category: the destination category name ("Main Story", "Side Quests", ' +
                '"Completed", "Failed", "Achievements", or a custom category like "The Curse of ' +
                'Strahd"). Must match an existing JournalEntry inside the Quests folder.',
            },
            autoMarkOnMove: {
              type: 'boolean',
              description:
                'For move-to-category: when targetCategory is "Completed", also set the completed ' +
                'flag + all checkboxes to 1; when targetCategory is "Failed", set completed=false. ' +
                'Default true. Set false to leave checkbox/completion state untouched.',
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
            'set-header',
            'clear-header',
            'move-to-category',
          ]),
          objectives: z.array(z.string().min(1)).optional(),
          secretObjectives: z.array(z.string().min(1)).optional(),
          objectiveText: z.string().optional(),
          secret: z.boolean().optional(),
          newName: z.string().optional(),
          headerImageUrl: z.string().url().optional(),
          headerMeta: z
            .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
            .optional(),
          headerMaskNumber: z.number().int().min(1).max(20).optional(),
          targetCategory: z.string().min(1).optional(),
          autoMarkOnMove: z.boolean().optional(),
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
          if (op === 'set-header' && !data.headerImageUrl) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'set-header requires headerImageUrl' });
          }
          if (op === 'move-to-category' && !data.targetCategory) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'move-to-category requires targetCategory' });
          }
        });

      const req = schema.parse(args);

      // Locate the page
      const match = await this.findQuestPage(req.questName, req.category);

      // move-to-category is a separate flow: it physically moves the page
      // document between parent JournalEntries (delete+create on Foundry side
      // via the bridge moveJournalPage call). After the move we may patch
      // flags on the new page.
      if (req.operation === 'move-to-category') {
        return await this.handleMoveToCategory(req, match);
      }

      // Read current state
      const current = await this.foundryClient.query('foundry-forge-mcp.getJournalPageContent', {
        journalId: match.journalId,
        pageId: match.pageId,
      });
      if (!current || current.error) {
        throw new Error(`Could not read current page: ${current?.error || 'no data'}`);
      }

      // Split current content into (header, objectives) so we can preserve
      // the header on operations that only touch objectives, and vice versa.
      const { headerHtml: currentHeaderHtml, objectivesHtml: currentObjectivesHtml } =
        splitQuestContent(current.content || '');
      const currentObjectives = parseObjectives(currentObjectivesHtml);
      const currentFlags = (current.flags && current.flags['simple-quest']) || {};
      const currentCheckboxes: Record<string, 0 | 1> = { ...(currentFlags.checkboxes || {}) };
      const currentSecret: Record<string, boolean> = { ...(currentFlags.secret || {}) };

      // Compute the patch
      let newObjectives = [...currentObjectives];
      let newCheckboxes = { ...currentCheckboxes };
      let newSecret = { ...currentSecret };
      let newCompleted = currentFlags.completed === true;
      let newName: string | undefined;
      let newHeaderHtml: string = currentHeaderHtml;
      let headerExplicitlyChanged = false;

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
          // Optional: also set/replace the header in the same call.
          if (req.headerImageUrl) {
            newHeaderHtml = buildHeaderTable({
              imageUrl: req.headerImageUrl,
              meta: req.headerMeta ?? [],
              maskNumber: req.headerMaskNumber ?? 4,
            });
            headerExplicitlyChanged = true;
          }
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
        case 'set-header': {
          newHeaderHtml = buildHeaderTable({
            imageUrl: req.headerImageUrl!,
            meta: req.headerMeta ?? [],
            maskNumber: req.headerMaskNumber ?? 4,
          });
          headerExplicitlyChanged = true;
          break;
        }
        case 'clear-header': {
          newHeaderHtml = '';
          headerExplicitlyChanged = true;
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

      // Foundry's Document.update merges nested objects. For set-objectives
      // (which fully replaces the checkbox/secret maps), we need to explicitly
      // delete any orphaned keys from the previous objective list. Foundry's
      // delete syntax is `-=<key>` set to null. We only do this when the
      // operation rewrites the whole list — otherwise targeted edits would
      // wipe other objectives.
      const isFullRewrite = req.operation === 'set-objectives';
      const finalCheckboxes: Record<string, any> = { ...newCheckboxes };
      const finalSecret: Record<string, any> = { ...newSecret };
      if (isFullRewrite) {
        for (const oldKey of Object.keys(currentCheckboxes)) {
          if (!(oldKey in newCheckboxes) && !/[.\[\]]/.test(oldKey)) {
            finalCheckboxes[`-=${oldKey}`] = null;
          }
        }
        for (const oldKey of Object.keys(currentSecret)) {
          if (!(oldKey in newSecret) && !/[.\[\]]/.test(oldKey)) {
            finalSecret[`-=${oldKey}`] = null;
          }
        }
      }

      const flagsPatch: Record<string, any> = {
        'simple-quest': {
          ...currentFlags,
          checkboxes: finalCheckboxes,
          secret: finalSecret,
          completed: newCompleted,
          completedSubquests,
          lastUpdated: Date.now(),
        },
      };

      // Build the bridge call. Content is ALWAYS recomposed and sent — even
      // when the operation only touches flags (rename, mark-complete on
      // already-complete page, etc.) — because the queries.ts handler defaults
      // a missing `content` to '' and silently wipes text.content. Composing
      // from preserved header + current objectives is a safe no-op when the
      // operation didn't intend to change content.
      const objectivesAffected =
        req.operation === 'set-objectives' ||
        req.operation === 'add-objective' ||
        req.operation === 'remove-objective' ||
        req.operation === 'check-objective' ||
        req.operation === 'uncheck-objective' ||
        req.operation === 'mark-complete' ||
        req.operation === 'mark-incomplete';
      const newObjectivesHtml = objectivesAffected
        ? objectivesToHtml(newObjectives)
        : currentObjectivesHtml;

      const updatePayload: any = {
        journalId: match.journalId,
        pageId: match.pageId,
        flags: flagsPatch,
        content: composeQuestContent(newHeaderHtml, newObjectivesHtml),
      };
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
        headerPresent: Boolean(newHeaderHtml),
        headerChanged: headerExplicitlyChanged,
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

  /**
   * Move a quest page to a different category JournalEntry. Resolves target
   * by category name within the Quests folder, calls the bridge moveJournalPage,
   * then optionally patches completion flags on the new page (Completed → set
   * all checkboxes + completed:true; Failed → completed:false).
   */
  private async handleMoveToCategory(
    req: any,
    match: { questName: string; category: string; journalId: string; pageId: string },
  ): Promise<any> {
    const target = req.targetCategory as string;
    if (target.toLowerCase() === match.category.toLowerCase()) {
      throw new Error(`Quest "${match.questName}" is already in category "${match.category}".`);
    }

    // Resolve target journal id by category name in the Quests folder.
    const journals = await this.foundryClient.query('foundry-forge-mcp.listJournals', { folder: 'Quests' });
    const list: any[] = Array.isArray(journals) ? journals : journals?.items || [];
    const targetJournal = list.find((j) => (j.name || '').toLowerCase() === target.toLowerCase());
    if (!targetJournal) {
      throw new Error(
        `No category JournalEntry named "${target}" in the Quests folder. Existing categories: ${list.map((j) => j.name).join(', ')}.`,
      );
    }

    // Perform the move.
    const moveResult = await this.foundryClient.query('foundry-forge-mcp.moveJournalPage', {
      sourceJournalId: match.journalId,
      sourcePageId: match.pageId,
      targetJournalId: targetJournal.id,
    });
    if (!moveResult || moveResult.error || moveResult.success === false) {
      throw new Error(`Move failed: ${moveResult?.error || 'unknown'}`);
    }
    const newPageId = moveResult.newPageId as string;
    const newJournalId = moveResult.newJournalId as string;

    // Auto-mark based on target. Default true; user can opt out.
    const autoMark = req.autoMarkOnMove !== false;
    let flagsTouched = false;
    if (autoMark) {
      const targetLower = target.toLowerCase();
      const isCompleted = targetLower === 'completed';
      const isFailed = targetLower === 'failed';
      if (isCompleted || isFailed) {
        // Read the just-moved page to compute its checkbox keys.
        const current = await this.foundryClient.query('foundry-forge-mcp.getJournalPageContent', {
          journalId: newJournalId,
          pageId: newPageId,
        });
        const { objectivesHtml } = splitQuestContent(current?.content || '');
        const objectives = parseObjectives(objectivesHtml);
        const currentFlags = (current?.flags && current.flags['simple-quest']) || {};

        const newCheckboxes: Record<string, 0 | 1> = {};
        for (const o of objectives) newCheckboxes[objectiveKey(o)] = isCompleted ? 1 : 0;

        const slug = questSlug(match.questName);
        const flagsPatch: Record<string, any> = {
          'simple-quest': {
            ...currentFlags,
            checkboxes: newCheckboxes,
            completed: isCompleted,
            completedSubquests: { ...(currentFlags.completedSubquests || {}), [slug]: isCompleted },
            lastUpdated: Date.now(),
          },
        };

        // Pass content alongside flags — queries.ts pads missing content to
        // empty string and wipes the page, so we MUST round-trip the current
        // content unchanged.
        const flagResult = await this.foundryClient.query('foundry-forge-mcp.updateJournalContent', {
          journalId: newJournalId,
          pageId: newPageId,
          content: current?.content || '',
          flags: flagsPatch,
        });
        if (!flagResult || flagResult.error) {
          throw new Error(`Move succeeded but auto-mark flag write failed: ${flagResult?.error || 'unknown'}`);
        }
        flagsTouched = true;
      }
    }

    return {
      success: true,
      questName: match.questName,
      operation: 'move-to-category',
      from: { category: match.category, journalId: match.journalId, pageId: match.pageId },
      to: { category: targetJournal.name, journalId: newJournalId, pageId: newPageId },
      autoMarkApplied: flagsTouched,
    };
  }

  private findObjectiveIndex(objectives: string[], text: string): number {
    const needle = text.trim().toLowerCase();
    return objectives.findIndex((o) => o.toLowerCase() === needle);
  }
}

// Keep the linter happy when KNOWN_CATEGORIES is exported for downstream tools.
export { KNOWN_CATEGORIES };
