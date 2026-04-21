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

      // 5. Pull the newly-spawned actor's items so we can diff against
      //    Reloaded (decide which traits to add vs. let stand).
      const actorFull: any = await this.foundryClient.query('foundry-forge-mcp.getCharacterInfo', {
        characterName: newActor.name,
      });
      const existingItemNames = new Set(
        (actorFull?.items ?? []).map((i: any) => String(i.name ?? '').toLowerCase()),
      );

      // 6. Apply field overrides in small chunks so that a failure in one
      //    category (e.g. dnd5e rejects the prof-bonus override) doesn't
      //    prevent the others from landing.
      const updateResults = await this.applyOverridesChunked(newActor.id, sb, input);
      // Concatenate successfully-written field keys for the response.
      const successfulUpdateKeys = updateResults.filter(r => r.ok).flatMap(r => r.fields);
      const failedUpdateChunks = updateResults.filter(r => !r.ok).map(r => ({ chunk: r.label, error: r.error }));

      // 7. Add Reloaded-only traits (no attack/damage/save — pure narrative).
      //    Traits whose names already exist on the actor (e.g. "Sunlight
      //    Sensitivity" inherited from the compendium Wight) are left alone;
      //    updating divergent descriptions ships in Phase 3a-C.
      const traitsToAdd = sb.traits
        .filter(t => !existingItemNames.has(t.name.toLowerCase()))
        .map(t => ({
          name: t.name,
          type: 'feat',
          system: {
            description: { value: `<p>${escapeHtml(t.description)}</p>` },
            source: { book: 'CoS Reloaded' },
            type: { value: 'monster' },
          },
        }));
      let addedTraitNames: string[] = [];
      if (traitsToAdd.length > 0) {
        const addResult: any = await this.foundryClient.query('foundry-forge-mcp.addActorItems', {
          actorId: newActor.id,
          items: traitsToAdd,
        });
        if (addResult?.success !== false) {
          addedTraitNames = traitsToAdd.map(t => t.name);
        } else {
          this.logger.warn('add-actor-items failed for traits', { error: addResult?.error });
        }
      }

      // 8. Update existing action items' structured combat data to match
      //    Reloaded: attack bonus, damage parts, save DC, reach/range. We
      //    patch the item's primary activity (type='attack' preferred when
      //    Reloaded has an attack bonus; type='save' preferred when Reloaded
      //    has a save; otherwise first activity). Items without activities
      //    (pre-dnd5e-4.x legacy items or pure-narrative feats) are skipped —
      //    their legacy field updates land in a follow-up.
      const itemsByName = new Map<string, any>();
      for (const item of actorFull?.items ?? []) {
        itemsByName.set(String(item.name ?? '').toLowerCase(), item);
      }
      const allReloadedActions = [
        ...sb.actions, ...sb.bonusActions, ...sb.reactions,
        ...sb.legendaryActions, ...sb.lairActions,
      ];
      const itemUpdates: Array<Record<string, any>> = [];
      const actionsSynced: string[] = [];
      const actionsSkippedNoItem: string[] = [];
      const actionsSkippedNoActivity: string[] = [];

      for (const action of allReloadedActions) {
        const item = itemsByName.get(action.name.toLowerCase());
        if (!item) {
          actionsSkippedNoItem.push(action.name);
          continue;
        }
        const activities = item.system?.activities ?? {};
        if (!activities || Object.keys(activities).length === 0) {
          actionsSkippedNoActivity.push(action.name);
          continue;
        }
        // Walk every activity on the item and patch only the fields relevant
        // to that activity's type. One item can have both an `attack` and a
        // `save` activity (e.g. Wight Commander Life Drain) — both need
        // Reloaded's values applied.
        const itemUpdate = buildItemActivityUpdate(item.id, activities, action.parsed);
        if (Object.keys(itemUpdate).length > 1) {
          itemUpdates.push(itemUpdate);
          actionsSynced.push(action.name);
        }
      }

      // Issue item updates one at a time so a bad single-item payload can't
      // hang the whole orchestrator. Skipped-item names end up in a report
      // field so the caller sees which actions didn't land.
      const actionSyncFailures: Array<{ name: string; error: string }> = [];
      for (let i = 0; i < itemUpdates.length; i++) {
        const iu = itemUpdates[i];
        const actionName = actionsSynced[i];
        try {
          const r: any = await this.foundryClient.query('foundry-forge-mcp.updateActorItems', {
            actorId: newActor.id,
            updates: [iu],
          });
          if (r?.success === false) {
            actionSyncFailures.push({ name: actionName, error: r?.error ?? 'update returned success=false' });
          }
        } catch (err: any) {
          actionSyncFailures.push({ name: actionName, error: err?.message ?? String(err) });
          this.logger.warn(`action sync "${actionName}" failed`, { error: err?.message, itemId: iu._id });
        }
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
          proficiencyBonus: sb.proficiencyBonus,
          skills: sb.skills,
          senses: sb.sensesText,
          languages: sb.languages,
        },
        appliedUpdates: successfulUpdateKeys.filter(k => !k.startsWith('flags.')),
        failedUpdateChunks,
        traitsAdded: addedTraitNames,
        traitsAlreadyPresent: sb.traits
          .filter(t => existingItemNames.has(t.name.toLowerCase()))
          .map(t => t.name),
        actionsSynced: actionsSynced.filter(n => !actionSyncFailures.find(f => f.name === n)),
        actionsSkippedNoItem,
        actionsSkippedNoActivity,
        actionSyncFailures,
        flagsStamped: ['foundry-forge-mcp.source', 'foundry-forge-mcp.reloadedName']
          .concat(input.file_path ? ['foundry-forge-mcp.reloadedPath'] : []),
        notes: [
          'Phase 3a-B: numeric overrides + skills/senses/languages/immunities/prof-bonus applied; Reloaded-only traits added as simple feats.',
          'Phase 3a-C: existing action items updated with Reloaded attack bonus, damage parts, save DC, reach/range (targeting the item\'s primary attack/save activity).',
          'Reloaded-only ACTIONS (not traits) that don\'t exist on the compendium base are not auto-created yet — add manually or wait for a follow-up phase.',
          'Versatile weapon alternatives (e.g. "or 2d10+4 slashing if two-handed") are parsed but not yet written to the item — dnd5e represents these via a separate activity path, shipping later.',
          'Actor landed in default folder "Foundry MCP Creatures" — move manually for now.',
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

  /**
   * Apply overrides in small categorized chunks. Each chunk is its own
   * update-actor call, so a dnd5e rejection of one category (e.g. the
   * prof-bonus override) doesn't block the others. Errors are caught per
   * chunk; the caller gets back a per-chunk success report.
   */
  private async applyOverridesChunked(
    actorId: string,
    sb: ReloadedStatblock,
    input: { file_path?: string | undefined },
  ): Promise<Array<{ label: string; fields: string[]; ok: boolean; error?: string }>> {
    const flagsChunk: Record<string, any> = {};
    this.stampFlags(flagsChunk, sb, input);

    const chunks: Array<{ label: string; payload: Record<string, any> }> = [
      { label: 'core-numerics', payload: this.buildCoreNumericsChunk(sb) },
      { label: 'saves', payload: this.buildSavesChunk(sb) },
      { label: 'prof-bonus', payload: this.buildProfBonusChunk(sb) },
      { label: 'skills', payload: this.buildSkillsChunk(sb) },
      { label: 'senses', payload: this.buildSensesChunk(sb) },
      { label: 'languages', payload: this.buildLanguagesChunk(sb) },
      { label: 'damage-condition-traits', payload: this.buildTraitsChunk(sb) },
      { label: 'flags', payload: flagsChunk },
    ].filter(c => Object.keys(c.payload).length > 0);

    const results: Array<{ label: string; fields: string[]; ok: boolean; error?: string }> = [];
    for (const { label, payload } of chunks) {
      const fields = Object.keys(payload);
      try {
        const r: any = await this.foundryClient.query('foundry-forge-mcp.updateActorData', {
          actorId,
          updates: payload,
        });
        if (r?.success === false) {
          results.push({ label, fields, ok: false, error: r?.error ?? 'update returned success=false' });
        } else {
          results.push({ label, fields, ok: true });
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.logger.warn(`chunk "${label}" failed`, { error: msg, fields });
        results.push({ label, fields, ok: false, error: msg });
      }
    }
    return results;
  }

  private buildCoreNumericsChunk(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};
    u['system.attributes.hp.max'] = sb.hp.avg;
    u['system.attributes.hp.value'] = sb.hp.avg;
    if (sb.hp.formula) u['system.attributes.hp.formula'] = sb.hp.formula;
    u['system.attributes.ac.flat'] = sb.ac;
    u['system.attributes.ac.calc'] = 'flat';
    for (const [mode, value] of Object.entries(sb.speed)) {
      u[`system.attributes.movement.${mode}`] = value;
    }
    for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
      u[`system.abilities.${ab}.value`] = sb.abilities[ab].score;
    }
    if (sb.challengeNumeric !== null) u['system.details.cr'] = sb.challengeNumeric;
    return u;
  }

  private buildSavesChunk(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};
    for (const ab of Object.keys(sb.saves)) {
      if (['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(ab)) {
        u[`system.abilities.${ab}.proficient`] = 1;
      }
    }
    return u;
  }

  private buildProfBonusChunk(sb: ReloadedStatblock): Record<string, any> {
    return sb.proficiencyBonus !== null
      ? { 'system.attributes.prof': sb.proficiencyBonus }
      : {};
  }

  private buildSkillsChunk(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};
    for (const skillName of Object.keys(sb.skills)) {
      const abbr = SKILL_NAME_TO_ABBR[skillName.toLowerCase()];
      if (!abbr) continue;
      // dnd5e 4.x uses `.value` (0=none, 1=full, 2=expertise) as the canonical
      // proficiency level. `.proficient` is a legacy boolean alias still read
      // by some call sites; we set both so display + derivation stay in sync.
      u[`system.skills.${abbr}.value`] = 1;
      u[`system.skills.${abbr}.proficient`] = 1;
    }
    return u;
  }

  private buildSensesChunk(sb: ReloadedStatblock): Record<string, any> {
    const modes = parseSenses(sb.sensesText);
    if (Object.keys(modes).length === 0) return {};
    const u: Record<string, any> = { 'system.attributes.senses.units': 'ft' };
    for (const [mode, feet] of Object.entries(modes)) {
      u[`system.attributes.senses.${mode}`] = feet;
    }
    return u;
  }

  private buildLanguagesChunk(sb: ReloadedStatblock): Record<string, any> {
    return sb.languages ? { 'system.traits.languages.custom': sb.languages } : {};
  }

  private buildTraitsChunk(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};
    assignTraitList(u, 'di', sb.damageImmunities, DAMAGE_TYPES);
    assignTraitList(u, 'dr', sb.damageResistances, DAMAGE_TYPES);
    assignTraitList(u, 'dv', sb.damageVulnerabilities, DAMAGE_TYPES);
    assignTraitList(u, 'ci', sb.conditionImmunities, CONDITION_TYPES);
    return u;
  }

  /** Legacy one-shot version; retained for external callers. */
  private buildOverrides(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};

    // === Core numerics (Phase 2 MVP) ===

    u['system.attributes.hp.max'] = sb.hp.avg;
    u['system.attributes.hp.value'] = sb.hp.avg;
    if (sb.hp.formula) u['system.attributes.hp.formula'] = sb.hp.formula;

    u['system.attributes.ac.flat'] = sb.ac;
    u['system.attributes.ac.calc'] = 'flat';

    for (const [mode, value] of Object.entries(sb.speed)) {
      u[`system.attributes.movement.${mode}`] = value;
    }

    for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
      u[`system.abilities.${ab}.value`] = sb.abilities[ab].score;
    }

    if (sb.challengeNumeric !== null) {
      u['system.details.cr'] = sb.challengeNumeric;
    }

    for (const ab of Object.keys(sb.saves)) {
      if (['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(ab)) {
        u[`system.abilities.${ab}.proficient`] = 1;
      }
    }

    // === Advanced fields (Phase 3a-B) ===

    // Proficiency bonus override — Reloaded sometimes prints a PB that
    // doesn't match dnd5e's CR-derived default (Wight Commander CR 10 derives
    // +4; Reloaded prints +3). Setting this field pins the actor's bonus.
    if (sb.proficiencyBonus !== null) {
      u['system.attributes.prof'] = sb.proficiencyBonus;
    }

    // Skills — map full name to dnd5e abbreviation, mark proficient. Expertise
    // detection (bonus = mod + 2*prof) is deferred; Reloaded doesn't mark it
    // explicitly and most NPCs don't use it.
    for (const [skillName, _bonus] of Object.entries(sb.skills)) {
      const abbr = SKILL_NAME_TO_ABBR[skillName.toLowerCase()];
      if (abbr) u[`system.skills.${abbr}.proficient`] = 1;
    }

    // Senses — parse darkvision/blindsight/tremorsense/truesight feet out of
    // the sensesText. Passive Perception is intentionally NOT set; dnd5e
    // derives it from WIS + Perception prof + prof bonus.
    const senseModes = parseSenses(sb.sensesText);
    if (Object.keys(senseModes).length > 0) {
      u['system.attributes.senses.units'] = 'ft';
      for (const [mode, feet] of Object.entries(senseModes)) {
        u[`system.attributes.senses.${mode}`] = feet;
      }
    }

    // Languages — push the raw Reloaded text into `.custom` (semicolon-
    // delimited; dnd5e renders it alongside the code list). We don't try
    // to map "Abyssal, Common, Draconic" to dnd5e's language codes for
    // MVP — future improvement.
    if (sb.languages) {
      u['system.traits.languages.custom'] = sb.languages;
    }

    // Damage / condition trait lists. Our parseTraitList recognizes canonical
    // dnd5e damage types and conditions; unrecognized tokens (e.g. the
    // "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks that
    // aren't Silvered" clause on Wight Commander) go into `.custom`.
    assignTraitList(u, 'di', sb.damageImmunities, DAMAGE_TYPES);
    assignTraitList(u, 'dr', sb.damageResistances, DAMAGE_TYPES);
    assignTraitList(u, 'dv', sb.damageVulnerabilities, DAMAGE_TYPES);
    assignTraitList(u, 'ci', sb.conditionImmunities, CONDITION_TYPES);

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

// ----- dnd5e system maps -----------------------------------------------------

const SKILL_NAME_TO_ABBR: Record<string, string> = {
  acrobatics: 'acr',
  'animal handling': 'ani',
  arcana: 'arc',
  athletics: 'ath',
  deception: 'dec',
  history: 'his',
  insight: 'ins',
  intimidation: 'itm',
  investigation: 'inv',
  medicine: 'med',
  nature: 'nat',
  perception: 'prc',
  performance: 'prf',
  persuasion: 'per',
  religion: 'rel',
  'sleight of hand': 'slt',
  stealth: 'ste',
  survival: 'sur',
};

const DAMAGE_TYPES = new Set([
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
]);

const CONDITION_TYPES = new Set([
  'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
  'prone', 'restrained', 'stunned', 'unconscious',
]);

/**
 * Split a Reloaded "Damage Resistances" / "Condition Immunities" / etc string
 * into recognized tokens (pushed to `.value`) and unrecognized trailing prose
 * (pushed to `.custom`). Handles the common "necrotic; bludgeoning, piercing,
 * and slashing from nonmagical attacks that aren't silvered" pattern — the
 * semicolon-prefixed clause stays as custom text.
 */
function assignTraitList(
  updates: Record<string, any>,
  field: 'di' | 'dr' | 'dv' | 'ci',
  raw: string | null,
  valid: Set<string>,
): void {
  if (!raw) return;
  const recognized: string[] = [];
  const customParts: string[] = [];

  // Split on semicolons FIRST (top-level grouping), then commas/and within.
  for (const segment of raw.split(';').map(s => s.trim()).filter(Boolean)) {
    const tokens = segment
      .replace(/\band\b/gi, ',')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);
    const allRecognized = tokens.every(t => valid.has(t));
    if (allRecognized) {
      recognized.push(...tokens);
    } else {
      // Any unrecognized token in this segment → treat whole segment as custom
      // text so clauses stay readable (e.g. "bludgeoning, piercing, and
      // slashing from nonmagical attacks").
      customParts.push(segment);
    }
  }

  if (recognized.length > 0) updates[`system.traits.${field}.value`] = recognized;
  if (customParts.length > 0) updates[`system.traits.${field}.custom`] = customParts.join('; ');
}

/** Parse "Darkvision 60 ft., passive Perception 14" → { darkvision: 60 }. */
function parseSenses(text: string): Record<string, number> {
  if (!text) return {};
  const out: Record<string, number> = {};
  // Only these keys exist on dnd5e's actor.system.attributes.senses
  const modes = ['darkvision', 'blindsight', 'tremorsense', 'truesight'] as const;
  for (const mode of modes) {
    const m = text.match(new RegExp(`\\b${mode}\\s+(\\d+)\\s*ft\\.?`, 'i'));
    if (m) out[mode] = parseInt(m[1], 10);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ----- Action → activity patching (Phase 3a-C) -------------------------------

/**
 * Build an update payload for one item targeting ALL of its activities that
 * have a corresponding field in the parsed Reloaded action. An item with both
 * an `attack` and a `save` activity (e.g. Life Drain) gets both branches
 * patched in a single update.
 */
function buildItemActivityUpdate(
  itemId: string,
  activities: Record<string, any>,
  parsed: import('../parsers/action-description.js').ParsedAction,
): Record<string, any> {
  const u: Record<string, any> = { _id: itemId };

  const hasAttackActivity = Object.values(activities).some(a => a?.type === 'attack');

  for (const [activityId, activity] of Object.entries(activities)) {
    const base = `system.activities.${activityId}`;
    const type = activity?.type;

    if (type === 'attack' && parsed.attackBonus !== undefined) {
      // dnd5e 4.x stores attack bonus as a string with leading sign
      u[`${base}.attack.bonus`] = (parsed.attackBonus >= 0 ? '+' : '') + parsed.attackBonus;
      if (parsed.attackType) {
        u[`${base}.attack.type.value`] = parsed.attackType;
      }

      // Damage on the attack activity (when the action has both attack and
      // save, damage usually lives on the attack side — the save is a
      // secondary effect like HP-reduction).
      if (parsed.damage.length > 0) {
        u[`${base}.damage.parts`] = parsed.damage.map(damagePartPayload);
      }

      // Reach / range live on the attack activity.
      if (parsed.reach !== undefined) {
        u[`${base}.range.reach`] = String(parsed.reach);
        u[`${base}.range.units`] = 'ft';
      }
      if (parsed.range) {
        u[`${base}.range.value`] = String(parsed.range.normal);
        if (parsed.range.long) u[`${base}.range.long`] = String(parsed.range.long);
        u[`${base}.range.units`] = 'ft';
      }
    }

    if (type === 'save' && parsed.save) {
      u[`${base}.save.ability`] = [parsed.save.ability];
      u[`${base}.save.dc.calculation`] = '';
      u[`${base}.save.dc.formula`] = String(parsed.save.dc);

      // If the action has damage AND there's no attack activity on this
      // item, the save activity owns the damage (e.g. Virulent Miasma:
      // save-only action with 4d6 poison).
      if (parsed.damage.length > 0 && !hasAttackActivity) {
        u[`${base}.damage.parts`] = parsed.damage.map(damagePartPayload);
        if (parsed.save.onSuccess === 'half') {
          u[`${base}.damage.onSave`] = 'half';
        }
      }
    }

    if (type === 'damage' && parsed.damage.length > 0) {
      u[`${base}.damage.parts`] = parsed.damage.map(damagePartPayload);
    }
  }

  return u;
}

function damagePartPayload(d: { formula: string; type: string }) {
  // dnd5e 4.x damage-part shape: { custom: { enabled: true, formula }, types: [type] }.
  // Using a custom formula sidesteps dice-denomination bookkeeping.
  return {
    custom: { enabled: true, formula: d.formula },
    types: [d.type],
  };
}
