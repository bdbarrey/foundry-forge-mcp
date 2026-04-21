import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';
import { parseReloadedStatblock, ReloadedStatblock } from '../parsers/reloaded-statblock.js';

export interface CreateActorToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

interface CompendiumBase {
  packId: string;
  itemId: string;
}

export class CreateActorTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: CreateActorToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'CreateActorTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-actor',
        description:
          'Build a Foundry actor from a CoS Reloaded statblock. Phase 2 MVP: compendium-hybrid path only — spawns from a compendium base (auto-searched by creature name if not given) and overrides numeric stats from the Reloaded statblock (HP, AC, speed, ability scores, CR, save proficiencies). Does NOT yet sync custom traits/actions, skills, damage/condition immunities, portraits, or move to a specific folder — those land in Phase 3+. Provide EITHER reloaded_source (the raw markdown chunk) OR file_path+creature_name (the tool reads the file and extracts the `### <creature_name>` section).',
        inputSchema: {
          type: 'object',
          properties: {
            reloaded_source: {
              type: 'string',
              description: 'Markdown containing exactly one <div class="statblock"> block. Use this OR file_path+creature_name.',
            },
            file_path: {
              type: 'string',
              description: 'Absolute path to a Reloaded markdown file (e.g. the Bestiary or a chapter file). Requires creature_name.',
            },
            creature_name: {
              type: 'string',
              description: 'Heading text under which the statblock lives in file_path (e.g. "Wight Commander" → matches `### Wight Commander`).',
            },
            compendium_base: {
              type: 'object',
              description: 'Optional explicit compendium source. If omitted, the tool auto-searches by parsed creature name and falls back to common base-name stems (e.g. "Wight Commander" → "Wight").',
              properties: {
                packId: { type: 'string', description: 'Compendium pack ID (e.g. "dnd5e.monsters").' },
                itemId: { type: 'string', description: 'Entry ID within the pack.' },
              },
              required: ['packId', 'itemId'],
            },
          },
        },
      },
    ];
  }

  async handleCreateActor(args: any): Promise<any> {
    const schema = z.object({
      reloaded_source: z.string().optional(),
      file_path: z.string().optional(),
      creature_name: z.string().optional(),
      compendium_base: z.object({
        packId: z.string().min(1),
        itemId: z.string().min(1),
      }).optional(),
    }).refine(
      d => d.reloaded_source || (d.file_path && d.creature_name),
      { message: 'Provide reloaded_source OR both file_path and creature_name' },
    );
    const input = schema.parse(args);

    this.logger.info('create-actor invoked', {
      hasSource: !!input.reloaded_source,
      filePath: input.file_path,
      creatureName: input.creature_name,
      explicitBase: !!input.compendium_base,
    });

    try {
      // 1. Get markdown source
      const markdown = await this.resolveSource(input);

      // 2. Parse Reloaded statblock
      const sb = parseReloadedStatblock(markdown);
      this.logger.debug('Parsed statblock', { name: sb.name, cr: sb.challenge });

      // 3. Find compendium base
      const base = input.compendium_base ?? await this.searchForCompendiumBase(sb.name);
      if (!base) {
        throw new Error(
          `No compendium base found for "${sb.name}". Pass compendium_base explicitly with {packId, itemId}, ` +
          `or use search-compendium to find a suitable base. Phase 6 (homebrew scratch-build) is not yet implemented.`,
        );
      }
      this.logger.info('Using compendium base', base);

      // 4. Spawn via compendium
      const spawn: any = await this.foundryClient.query('foundry-forge-mcp.createActorFromCompendium', {
        packId: base.packId,
        itemId: base.itemId,
        customNames: [sb.name],
        quantity: 1,
        addToScene: false,
      });
      if (!spawn?.success || !spawn.actors?.length) {
        throw new Error(
          `Compendium spawn failed for pack=${base.packId} item=${base.itemId}: ${spawn?.errors?.join('; ') ?? 'unknown error'}`,
        );
      }
      const newActor = spawn.actors[0] as { id: string; name: string };
      this.logger.info('Actor spawned from compendium', { id: newActor.id, name: newActor.name });

      // 5. Build + apply numeric overrides
      const updates = this.buildNumericOverrides(sb);
      this.stampFlags(updates, sb, input);

      const upd: any = await this.foundryClient.query('foundry-forge-mcp.updateActorData', {
        actorId: newActor.id,
        updates,
      });
      if (!upd?.success) {
        throw new Error(`Update failed on spawned actor ${newActor.id}: ${upd?.error ?? 'unknown error'}`);
      }

      return {
        success: true,
        actorId: newActor.id,
        actorName: newActor.name,
        compendiumBase: base,
        parsed: {
          name: sb.name,
          challenge: sb.challenge,
          ac: sb.ac,
          hp: sb.hp,
          speed: sb.speed,
        },
        appliedUpdates: Object.keys(updates).filter(k => !k.startsWith('flags.')),
        flagsStamped: ['foundry-forge-mcp.source', 'foundry-forge-mcp.reloadedName']
          .concat(input.file_path ? ['foundry-forge-mcp.reloadedPath'] : []),
        notes: [
          'Numeric overrides only (Phase 2 MVP): HP, AC, speed, ability scores, CR, save proficiencies.',
          'Actor landed in default folder "Foundry MCP Creatures" — move manually for now; folder control ships in a follow-up.',
          'Custom traits/actions (e.g. Reloaded-only features like "Chill of the Grave"), skills, damage/condition immunities, and portrait are NOT synced yet (Phases 3, 3a, 5).',
        ],
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-actor', 'actor creation');
    }
  }

  /** Resolve input to one markdown chunk containing a statblock div. */
  private async resolveSource(input: {
    reloaded_source?: string | undefined;
    file_path?: string | undefined;
    creature_name?: string | undefined;
  }): Promise<string> {
    if (input.reloaded_source) return input.reloaded_source;
    if (!input.file_path || !input.creature_name) {
      throw new Error('Missing source input (should be caught by schema, defense in depth)');
    }
    const content = await readFile(input.file_path, 'utf8');
    return extractStatblockSection(content, input.creature_name, input.file_path);
  }

  /** Look up a compendium actor by name. Falls back through common Reloaded name patterns. */
  private async searchForCompendiumBase(name: string): Promise<CompendiumBase | null> {
    const candidates = Array.from(nameVariants(name));
    this.logger.debug('Searching compendium for base', { name, candidates });

    for (const candidate of candidates) {
      const result: any = await this.foundryClient.query('foundry-forge-mcp.searchCompendium', {
        query: candidate,
        packType: 'Actor',
      });
      const hits = extractSearchHits(result);
      if (hits.length === 0) continue;
      // Prefer exact case-insensitive match
      const exact = hits.find((h: any) => (h.name ?? '').toLowerCase() === candidate.toLowerCase());
      const pick = exact ?? hits[0];
      const packId = pick.packId ?? pick.pack ?? pick.packName;
      const itemId = pick.id ?? pick.itemId ?? pick._id;
      if (packId && itemId) {
        this.logger.info('Compendium base matched', { candidate, packId, itemId, name: pick.name });
        return { packId, itemId };
      }
    }
    return null;
  }

  /** Compute Foundry dot-notation updates from the parsed statblock. */
  private buildNumericOverrides(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};

    // HP — set max, restore current to max, push formula if known
    u['system.attributes.hp.max'] = sb.hp.avg;
    u['system.attributes.hp.value'] = sb.hp.avg;
    if (sb.hp.formula) u['system.attributes.hp.formula'] = sb.hp.formula;

    // AC — use flat for Reloaded's printed value (side-steps dnd5e's equipment-derived calc)
    u['system.attributes.ac.flat'] = sb.ac;
    u['system.attributes.ac.calc'] = 'flat';

    // Speeds — dnd5e organizes per mode (walk/fly/climb/swim/burrow)
    for (const [mode, value] of Object.entries(sb.speed)) {
      u[`system.attributes.movement.${mode}`] = value;
    }

    // Ability scores
    for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
      u[`system.abilities.${ab}.value`] = sb.abilities[ab].score;
    }

    // CR — numeric part. Reloaded prints conditional text on some bosses
    // ("21, or 19 when fought in sunlight"); we take the leading integer.
    if (sb.challengeNumeric !== null) {
      u['system.details.cr'] = sb.challengeNumeric;
    }

    // Save proficiencies. dnd5e derives save bonus from ability mod + prof, so
    // setting `proficient=1` on the ability gets us the printed bonus provided
    // the creature's prof bonus (from CR) matches. Strict override of the
    // Reloaded vs derived value isn't supported without a prof override, which
    // we defer to Phase 3a.
    for (const ab of Object.keys(sb.saves)) {
      if (['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(ab)) {
        u[`system.abilities.${ab}.proficient`] = 1;
      }
    }

    return u;
  }

  private stampFlags(
    u: Record<string, any>,
    sb: ReloadedStatblock,
    input: { file_path?: string | undefined },
  ): void {
    u['flags.foundry-forge-mcp.source'] = 'reloaded-hybrid';
    u['flags.foundry-forge-mcp.reloadedName'] = sb.name;
    if (input.file_path) u['flags.foundry-forge-mcp.reloadedPath'] = input.file_path;
    u['flags.foundry-forge-mcp.createdAt'] = new Date().toISOString();
  }
}

// ----- helpers --------------------------------------------------------------

/** Yield name variants to search for in a compendium: exact, pre-comma stem, role-stripped stem. */
function* nameVariants(name: string): Generator<string> {
  yield name;
  const preComma = name.split(',')[0].trim();
  if (preComma && preComma !== name) yield preComma;

  // Strip trailing role/title tokens: "Wight Commander" → "Wight"
  const roleStripped = preComma.replace(
    /\s+(Commander|Captain|Lord|Lady|Knight|Warrior|Mage|Priest|Priestess|Lieutenant|King|Queen|Hero|Chief|Boss|Leader|Champion|Slayer|Hunter)\s*$/i,
    '',
  ).trim();
  if (roleStripped && roleStripped !== preComma) yield roleStripped;
}

/** searchCompendium response shape varies; normalize to an array of hits. */
function extractSearchHits(result: any): any[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.results)) return result.results;
  if (Array.isArray(result.response)) return result.response;
  // The dnd5e search returns objects keyed by pack; flatten.
  if (typeof result === 'object') {
    const nested = Object.values(result).filter(v => Array.isArray(v)).flat();
    if (nested.length) return nested;
  }
  return [];
}

/** Extract the markdown chunk under `### <heading>` in a file. Stops at next `##`/`###`. */
export function extractStatblockSection(
  fileContent: string,
  heading: string,
  sourcePath?: string,
): string {
  const lines = fileContent.split(/\r?\n/);
  const startIdx = lines.findIndex(l => l.trim() === `### ${heading}`);
  if (startIdx < 0) {
    const where = sourcePath ? ` in ${sourcePath}` : '';
    throw new Error(`Heading "### ${heading}" not found${where}`);
  }
  const relEnd = lines.slice(startIdx + 1).findIndex(l => /^#{1,3}\s/.test(l));
  const end = relEnd < 0 ? lines.length : startIdx + 1 + relEnd;
  return lines.slice(startIdx, end).join('\n');
}
