// Phase 4: audit-actor.
//
// Read-only tool. Diffs a Foundry actor against a Reloaded source (or runs a
// Foundry-only sanity check) and returns a structured divergence list with
// severity. Goal: turn "build → notice things look wrong → guess what to fix"
// into "build → run audit → fix only what's flagged."
//
// Severity:
//   critical — combat math wrong (HP, AC, save DC, attack bonus, damage,
//              missing action item, missing required save proficiency)
//   medium   — printed value diverges but plays correctly (skill prof level,
//              senses, ranges, prof bonus, alignment, languages, damage/cond
//              traits, CR, speed)
//   low      — text/cosmetic (action description text, name punctuation)

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';
import { parseReloadedStatblock, ReloadedStatblock, StatblockFeature } from '../parsers/reloaded-statblock.js';
import { ParsedAction, AbilityKey } from '../parsers/action-description.js';
import { extractStatblockSection, stripUsageSuffix } from './create-actor.js';

export type Severity = 'critical' | 'medium' | 'low';
export type Status = 'match' | 'divergence' | 'missing';

export interface AuditDivergence {
  field: string;
  reloaded: unknown;
  foundry: unknown;
  status: Status;
  severity: Severity;
  note?: string | undefined;
}

export interface AuditActionResult {
  name: string;
  itemId?: string | undefined;
  status: 'match' | 'missing-item' | 'no-activities' | 'has-divergences';
  divergences: AuditDivergence[];
}

export interface AuditResult {
  summary: {
    total: number;
    matches: number;
    divergences: number;
    criticalDivergences: number;
    mediumDivergences: number;
    lowDivergences: number;
  };
  stats: AuditDivergence[];
  saves: AuditDivergence[];
  skills: AuditDivergence[];
  senses: AuditDivergence[];
  traitsList: AuditDivergence[];
  features: {
    presentOnReloaded: string[];
    presentOnActor: string[];
    missingFromActor: string[];
    extraOnActor: string[];
    /**
     * Pairs of items on the actor whose names are stem-equivalent (i.e.
     * "Tanglefoot" + "Tanglefoot (1/day)") — leftovers of pre-Phase-8 builds
     * where the usage suffix wasn't normalized away. Caller can issue
     * `remove-actor-items` to clean up.
     */
    duplicates: Array<{ stem: string; ids: string[]; names: string[] }>;
  };
  actions: AuditActionResult[];
}

// Minimal shapes of what we read from foundry. Everything is `any`-loose at the
// boundary because dnd5e schema versions wiggle these fields around.
export interface ActorSnapshot {
  id: string;
  name: string;
  /**
   * v0.1.20: actor.img URL (the portrait shown on the character sheet) and
   * prototypeToken.texture.src (the token image, often an animated webm for
   * Beneos-canon NPCs). Surfaced so audit-actor can detect portrait_canon
   * divergences — e.g. a beneos-tagged NPC whose img still points at a DDB
   * default after a build that used the wrong compendium base.
   */
  img?: string;
  tokenImg?: string;
  system?: any;
  items?: ActorItemSnapshot[];
}

export interface ActorItemSnapshot {
  id?: string;
  _id?: string;
  name?: string;
  type?: string;
  system?: any;
  flags?: any;
  /**
   * Item-side ActiveEffect documents. Used by Phase 10A to verify that a save
   * activity's `effects[]` link points at a real item effect carrying the
   * expected condition status. Module's getCharacterInfo passes these through.
   */
  effects?: any[];
}

const SKILL_NAME_TO_ABBR: Record<string, string> = {
  acrobatics: 'acr', 'animal handling': 'ani', arcana: 'arc', athletics: 'ath',
  deception: 'dec', history: 'his', insight: 'ins', intimidation: 'itm',
  investigation: 'inv', medicine: 'med', nature: 'nat', perception: 'prc',
  performance: 'prf', persuasion: 'per', religion: 'rel', 'sleight of hand': 'slt',
  stealth: 'ste', survival: 'sur',
};

const SKILL_TO_ABILITY: Record<string, AbilityKey> = {
  acr: 'dex', ani: 'wis', arc: 'int', ath: 'str', dec: 'cha', his: 'int',
  ins: 'wis', itm: 'cha', inv: 'int', med: 'wis', nat: 'int', prc: 'wis',
  prf: 'cha', per: 'cha', rel: 'int', slt: 'dex', ste: 'dex', sur: 'wis',
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

const SENSE_MODES = ['darkvision', 'blindsight', 'tremorsense', 'truesight'] as const;

// Multiattack is a narrative wrapper, not a real action item — skip it in
// missing-action checks. Same convention as create-actor's Phase 3b loop.
const SKIP_ACTION_NAMES = new Set(['multiattack']);

/**
 * Pure comparison: actor + statblock → audit result. Exported for tests.
 * No Foundry / network access.
 */
export function compareActor(
  actor: ActorSnapshot,
  sb: ReloadedStatblock,
): AuditResult {
  const stats: AuditDivergence[] = [];
  const saves: AuditDivergence[] = [];
  const skills: AuditDivergence[] = [];
  const senses: AuditDivergence[] = [];
  const traitsList: AuditDivergence[] = [];

  compareCoreNumerics(actor, sb, stats);
  compareSaves(actor, sb, saves);
  compareSkills(actor, sb, skills);
  compareSenses(actor, sb, senses);
  compareTraitsList(actor, sb, traitsList);

  const features = compareFeatures(actor, sb);
  const actions = compareActions(actor, sb);

  // Aggregate counts.
  const allDivergences = [
    ...stats, ...saves, ...skills, ...senses, ...traitsList,
    ...actions.flatMap(a => a.divergences),
  ];
  // Treat each missing action as a divergence too (severity baked into action result).
  const missingActions = actions.filter(a => a.status === 'missing-item');
  for (const ma of missingActions) {
    allDivergences.push({
      field: `actions[${ma.name}]`,
      reloaded: 'present',
      foundry: 'missing',
      status: 'missing',
      severity: 'critical',
    });
  }
  // Missing/extra features as divergences.
  for (const name of features.missingFromActor) {
    allDivergences.push({
      field: `features[${name}]`,
      reloaded: 'present',
      foundry: 'missing',
      status: 'missing',
      severity: 'medium',
    });
  }

  const total = allDivergences.length;
  const divergences = allDivergences.filter(d => d.status !== 'match').length;
  const matches = total - divergences;

  const summary = {
    total,
    matches,
    divergences,
    criticalDivergences: allDivergences.filter(d => d.severity === 'critical' && d.status !== 'match').length,
    mediumDivergences: allDivergences.filter(d => d.severity === 'medium' && d.status !== 'match').length,
    lowDivergences: allDivergences.filter(d => d.severity === 'low' && d.status !== 'match').length,
  };

  return { summary, stats, saves, skills, senses, traitsList, features, actions };
}

// ----- core numerics ---------------------------------------------------------

function compareCoreNumerics(
  actor: ActorSnapshot,
  sb: ReloadedStatblock,
  out: AuditDivergence[],
): void {
  const sys = actor.system ?? {};
  const attrs = sys.attributes ?? {};
  const details = sys.details ?? {};
  const abilities = sys.abilities ?? {};

  // HP max — critical, combat math.
  const hpMax = numOrNull(attrs.hp?.max);
  pushCmp(out, 'hp.max', sb.hp.avg, hpMax, 'critical');

  // AC — critical. dnd5e exposes `value` (derived) and `flat` (override). When
  // create-actor sets calc='flat', `value` should equal `flat`; either matching
  // counts as a hit.
  const acFlat = numOrNull(attrs.ac?.flat);
  const acValue = numOrNull(attrs.ac?.value);
  const acMatch = acFlat === sb.ac || acValue === sb.ac;
  out.push({
    field: 'ac',
    reloaded: sb.ac,
    foundry: { flat: acFlat, value: acValue },
    status: acMatch ? 'match' : 'divergence',
    severity: 'critical',
  });

  // Speed per mode — medium. Movement units default to ft.
  const movement = attrs.movement ?? {};
  for (const [mode, feet] of Object.entries(sb.speed)) {
    pushCmp(out, `speed.${mode}`, feet, numOrNull(movement[mode]), 'medium');
  }

  // Ability scores — critical (every roll uses these).
  for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
    pushCmp(out, `abilities.${ab}`, sb.abilities[ab].score,
      numOrNull(abilities[ab]?.value), 'critical');
  }

  // CR — medium. dnd5e derives prof from CR so this affects derived modifiers,
  // but hp/ac/abilities are explicit overrides so a CR mismatch alone won't
  // wreck combat math.
  if (sb.challengeNumeric !== null) {
    pushCmp(out, 'cr', sb.challengeNumeric, numOrNull(details.cr), 'medium');
  }

  // Alignment — low (cosmetic).
  if (sb.alignment) {
    const actorAlign = strOrNull(details.alignment);
    out.push({
      field: 'alignment',
      reloaded: sb.alignment,
      foundry: actorAlign,
      status: caseInsensitiveEq(sb.alignment, actorAlign) ? 'match' : 'divergence',
      severity: 'low',
    });
  }

  // Proficiency bonus — medium. Known to be CR-derived in dnd5e 4.x+ and
  // sometimes ignored when written; flag the divergence for visibility.
  if (sb.proficiencyBonus !== null) {
    pushCmp(out, 'prof', sb.proficiencyBonus, numOrNull(attrs.prof), 'medium', {
      note: 'dnd5e derives prof from CR; manual override may not stick',
    });
  }
}

// ----- saves -----------------------------------------------------------------

function compareSaves(
  actor: ActorSnapshot,
  sb: ReloadedStatblock,
  out: AuditDivergence[],
): void {
  const abilities = actor.system?.abilities ?? {};
  // Every ability listed in the statblock's saves should have proficient ≥ 1.
  // Missing it makes the save modifier wrong (loses prof bonus) — critical.
  for (const ab of Object.keys(sb.saves)) {
    const profLevel = numOrNull(abilities[ab]?.proficient);
    out.push({
      field: `saves.${ab}.proficient`,
      reloaded: 1,
      foundry: profLevel,
      status: profLevel !== null && profLevel >= 1 ? 'match' : 'divergence',
      severity: 'critical',
    });
  }
}

// ----- skills ----------------------------------------------------------------

function compareSkills(
  actor: ActorSnapshot,
  sb: ReloadedStatblock,
  out: AuditDivergence[],
): void {
  const sys = actor.system ?? {};
  const actorSkills = sys.skills ?? {};
  const abilities = sys.abilities ?? {};
  const prof = numOrNull(sys.attributes?.prof) ?? sb.proficiencyBonus ?? 0;

  for (const [skillName, printedMod] of Object.entries(sb.skills)) {
    const abbr = SKILL_NAME_TO_ABBR[skillName.toLowerCase()];
    if (!abbr) continue;

    // Same level inference as create-actor's buildSkillsChunk so audit and
    // build agree on what the printed modifier implies.
    const abilityKey = SKILL_TO_ABILITY[abbr];
    const abilityScore = abilityKey ? numOrNull(abilities[abilityKey]?.value) : null;
    let expectedLevel: 1 | 2 | 0.5 = 1;
    if (abilityScore !== null && prof > 0) {
      const abilityMod = Math.floor((abilityScore - 10) / 2);
      const baseProf = abilityMod + prof;
      const delta = printedMod - baseProf;
      if (delta === prof) expectedLevel = 2;
      else if (delta === Math.ceil(prof / 2)) expectedLevel = 0.5;
    }

    const actorLevel = numOrNull(actorSkills[abbr]?.proficient);
    out.push({
      field: `skills.${abbr}`,
      reloaded: { mod: printedMod, expectedLevel },
      foundry: { proficient: actorLevel },
      status: actorLevel === expectedLevel ? 'match' : 'divergence',
      severity: 'medium',
    });
  }
}

// ----- senses ----------------------------------------------------------------

function compareSenses(
  actor: ActorSnapshot,
  sb: ReloadedStatblock,
  out: AuditDivergence[],
): void {
  const actorSenses = actor.system?.attributes?.senses ?? {};
  const parsedSenses = parseSensesText(sb.sensesText);
  for (const mode of SENSE_MODES) {
    const reloaded = parsedSenses[mode];
    const foundry = numOrNull(actorSenses[mode]);
    if (reloaded === undefined && (foundry === null || foundry === 0)) continue;
    if (reloaded === undefined) continue; // foundry has it, reloaded doesn't — that's the base's choice; ignore
    pushCmp(out, `senses.${mode}`, reloaded, foundry, 'medium');
  }
}

function parseSensesText(text: string): Record<string, number> {
  if (!text) return {};
  const out: Record<string, number> = {};
  for (const mode of SENSE_MODES) {
    const m = text.match(new RegExp(`\\b${mode}\\s+(\\d+)\\s*ft\\.?`, 'i'));
    if (m) out[mode] = parseInt(m[1], 10);
  }
  return out;
}

// ----- damage / condition / language traits ---------------------------------

function compareTraitsList(
  actor: ActorSnapshot,
  sb: ReloadedStatblock,
  out: AuditDivergence[],
): void {
  const traits = actor.system?.traits ?? {};
  compareTokenList(out, 'traits.di', sb.damageImmunities, traits.di, DAMAGE_TYPES);
  compareTokenList(out, 'traits.dr', sb.damageResistances, traits.dr, DAMAGE_TYPES);
  compareTokenList(out, 'traits.dv', sb.damageVulnerabilities, traits.dv, DAMAGE_TYPES);
  compareTokenList(out, 'traits.ci', sb.conditionImmunities, traits.ci, CONDITION_TYPES);

  // Languages: textual; if reloaded has any languages and actor's custom field
  // is empty (and value array is also empty), flag low.
  if (sb.languages) {
    const custom = strOrNull(traits.languages?.custom);
    const valueArr = Array.isArray(traits.languages?.value) ? traits.languages.value : [];
    out.push({
      field: 'languages',
      reloaded: sb.languages,
      foundry: { custom, value: valueArr },
      status: (custom && custom.trim().length > 0) || valueArr.length > 0 ? 'match' : 'divergence',
      severity: 'low',
      note: 'textual; presence-only check',
    });
  }
}

function compareTokenList(
  out: AuditDivergence[],
  field: string,
  reloadedRaw: string | null,
  foundryTrait: any,
  recognized: Set<string>,
): void {
  if (!reloadedRaw) return;
  // Tokenize reloaded the same way create-actor's assignTraitList does (split
  // on commas + " and ", lowercase, intersect with recognized set).
  const reloadedTokens = tokenizeTraitList(reloadedRaw, recognized);

  const foundryValue = Array.isArray(foundryTrait?.value)
    ? new Set<string>(foundryTrait.value.map((v: any) => String(v).toLowerCase()))
    : new Set<string>();

  const missing: string[] = [];
  for (const t of reloadedTokens) {
    if (!foundryValue.has(t)) missing.push(t);
  }
  out.push({
    field,
    reloaded: [...reloadedTokens],
    foundry: [...foundryValue],
    status: missing.length === 0 ? 'match' : 'divergence',
    severity: 'medium',
    note: missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
  });
}

function tokenizeTraitList(raw: string, recognized: Set<string>): Set<string> {
  // Mirror create-actor's assignTraitList: split on `;` FIRST so a
  // semicolon-prefixed conditional clause (e.g. "necrotic; bludgeoning,
  // piercing, and slashing from nonmagical attacks") doesn't leak its
  // damage-type tokens into the recognized set. Within each segment, an
  // all-or-nothing rule: if ANY token in a segment is unrecognized, the whole
  // segment is treated as custom prose (so its damage-type words don't count
  // as proper resistances/immunities).
  const out = new Set<string>();
  for (const segment of raw.split(';').map(s => s.trim()).filter(Boolean)) {
    const tokens = segment
      .replace(/\band\b/gi, ',')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) continue;
    const allRecognized = tokens.every(t => recognized.has(t));
    if (!allRecognized) continue;
    for (const t of tokens) out.add(t);
  }
  return out;
}

// ----- traits / features (item-level) ----------------------------------------

function compareFeatures(
  actor: ActorSnapshot,
  sb: ReloadedStatblock,
): AuditResult['features'] {
  const presentOnReloaded = sb.traits.map(t => t.name);
  const items = actor.items ?? [];

  // Phase 8: index by both full lower-case name AND stem (usage suffix
  // stripped) so a base item "Tanglefoot" matches a Reloaded "Tanglefoot
  // (1/day)" and vice versa.
  const itemsByLcName = new Map<string, ActorItemSnapshot>();
  const itemsByLcStem = new Map<string, ActorItemSnapshot>();
  for (const it of items) {
    const fullName = String(it.name ?? '');
    if (!fullName) continue;
    itemsByLcName.set(fullName.toLowerCase(), it);
    const stem = stripUsageSuffix(fullName).stem.toLowerCase();
    if (stem) itemsByLcStem.set(stem, it);
  }

  const allReloadedNamesFull = new Set<string>(
    [...sb.traits, ...sb.actions, ...sb.bonusActions, ...sb.reactions,
      ...sb.legendaryActions, ...sb.lairActions]
      .map(f => f.name.toLowerCase()),
  );
  const allReloadedNamesStem = new Set<string>(
    [...sb.traits, ...sb.actions, ...sb.bonusActions, ...sb.reactions,
      ...sb.legendaryActions, ...sb.lairActions]
      .map(f => stripUsageSuffix(f.name).stem.toLowerCase()),
  );

  const missingFromActor: string[] = [];
  for (const trait of sb.traits) {
    const traitLc = trait.name.toLowerCase();
    const traitStem = stripUsageSuffix(trait.name).stem.toLowerCase();
    if (!itemsByLcName.has(traitLc) && !itemsByLcStem.has(traitStem)) {
      missingFromActor.push(trait.name);
    }
  }

  // Group items by stem so "Tanglefoot" + "Tanglefoot (1/day)" (a leftover
  // from a pre-Phase-8 build) collapse into one duplicate entry instead of
  // both showing up in extraOnActor.
  const itemsByStemAll = new Map<string, ActorItemSnapshot[]>();
  for (const item of items) {
    const fullName = String(item.name ?? '');
    if (!fullName) continue;
    const stem = stripUsageSuffix(fullName).stem.toLowerCase();
    if (!stem) continue;
    const arr = itemsByStemAll.get(stem) ?? [];
    arr.push(item);
    itemsByStemAll.set(stem, arr);
  }

  // Anything present on the actor that isn't on Reloaded (any section). Skip
  // the no-name catch-all and obvious harmless types (class, background).
  // Multiattack always wraps other actions; skip from "extra" too.
  const presentOnActor: string[] = [];
  const extraOnActor: string[] = [];
  const duplicates: AuditResult['features']['duplicates'] = [];
  const dupeStems = new Set<string>();
  for (const [stem, group] of itemsByStemAll) {
    if (group.length > 1) {
      duplicates.push({
        stem,
        ids: group.map(g => g.id ?? g._id ?? '').filter(Boolean),
        names: group.map(g => String(g.name ?? '')),
      });
      dupeStems.add(stem);
    }
  }

  for (const item of items) {
    const name = String(item.name ?? '');
    if (!name) continue;
    presentOnActor.push(name);
    const lc = name.toLowerCase();
    const stem = stripUsageSuffix(name).stem.toLowerCase();
    if (allReloadedNamesFull.has(lc)) continue;
    if (allReloadedNamesStem.has(stem)) continue;
    if (SKIP_ACTION_NAMES.has(stripUsageSuffix(name).stem.toLowerCase())) continue;
    // Items added by create-actor are flagged — they're not "extras" relative
    // to Reloaded since create-actor put them there from a Reloaded entry.
    const flagSrc = item.flags?.['foundry-forge-mcp']?.source as string | undefined;
    if (flagSrc && flagSrc.startsWith('reloaded-')) continue;
    // If this item is part of a duplicate stem-pair, the duplicates field
    // already surfaces it — don't double-report in extraOnActor.
    if (dupeStems.has(stem)) continue;
    extraOnActor.push(name);
  }

  return { presentOnReloaded, presentOnActor, missingFromActor, extraOnActor, duplicates };
}

// ----- actions ---------------------------------------------------------------

function compareActions(
  actor: ActorSnapshot,
  sb: ReloadedStatblock,
): AuditActionResult[] {
  const items = actor.items ?? [];
  // Phase 8: stem-keyed map mirrors compareFeatures so post-Phase-8 builds
  // (item name = bare stem) audit clean against Reloaded "(1/day)" actions.
  const itemsByLcName = new Map<string, ActorItemSnapshot>();
  const itemsByLcStem = new Map<string, ActorItemSnapshot>();
  for (const it of items) {
    const fullName = String(it.name ?? '');
    if (!fullName) continue;
    itemsByLcName.set(fullName.toLowerCase(), it);
    const stem = stripUsageSuffix(fullName).stem.toLowerCase();
    if (stem) itemsByLcStem.set(stem, it);
  }

  const allReloadedActions: StatblockFeature[] = [
    ...sb.actions, ...sb.bonusActions, ...sb.reactions,
    ...sb.legendaryActions, ...sb.lairActions,
  ];

  const results: AuditActionResult[] = [];
  for (const action of allReloadedActions) {
    const lcName = action.name.toLowerCase();
    const lcStem = stripUsageSuffix(action.name).stem.toLowerCase();
    if (SKIP_ACTION_NAMES.has(lcStem)) {
      // Multiattack: just check presence; description is freeform.
      const item = itemsByLcName.get(lcName) ?? itemsByLcStem.get(lcStem);
      results.push({
        name: action.name,
        itemId: item?.id ?? item?._id,
        status: item ? 'match' : 'missing-item',
        divergences: [],
      });
      continue;
    }

    const item = itemsByLcName.get(lcName) ?? itemsByLcStem.get(lcStem);
    if (!item) {
      results.push({
        name: action.name,
        status: 'missing-item',
        divergences: [],
      });
      continue;
    }
    const itemId = item.id ?? item._id;
    const activities = item.system?.activities ?? {};
    // Preserve activity ID by injecting key as _id. Foundry's serialized
    // activities are a Record<id, body> where the body has no _id field —
    // Object.values() would discard the IDs and break rules like
    // attack-save.chain that compare triggeredActivityId against saveAct._id.
    // Test fixtures may pre-set _id on the body; respect that if present.
    const activityList = Object.entries(activities as Record<string, any>).map(
      ([id, body]) => ({ ...(body ?? {}), _id: body?._id ?? id }),
    );

    const divergences = compareSingleAction(action, item, activityList);
    results.push({
      name: action.name,
      itemId,
      status: activityList.length === 0
        ? 'no-activities'
        : (divergences.length === 0 ? 'match' : 'has-divergences'),
      divergences,
    });
  }

  return results;
}

/**
 * Phase 11 — declarative activity-completeness rule. Each rule decides whether
 * it applies (`appliesWhen`) and what divergence to surface if the live data
 * doesn't match Reloaded (`check`). The framework runs them in order; rules
 * are independent so adding a new check just appends to ACTIVITY_RULES.
 *
 * Why this shape: the per-activity audit kept growing inline conditionals as
 * each Phase shipped (10A condition link, 10A.7 targeting, future chain
 * detection). Declarative rules let us add a check by appending one entry
 * instead of weaving more if-blocks into a 200-line function.
 */
export interface ActivityRuleContext {
  /**
   * Full source action (action.parsed is what most rules read; action.name +
   * action.description are needed for the description-prefix rule).
   */
  action: StatblockFeature;
  parsed: import('../parsers/action-description.js').ParsedAction;
  item: ActorItemSnapshot;
  activities: any[];
  /** First activity matching the type, or undefined. */
  attackAct?: any;
  saveAct?: any;
  damageAct?: any;
}

export interface ActivityRule {
  /** Stable identifier for diagnostics + test references. */
  id: string;
  /** Human-readable label for the rule. */
  label: string;
  /**
   * Gate: does this rule apply to the given action? Returns false to skip.
   * Examples: "rule applies when parsed has a save and a condition" or
   * "rule applies when parsed has an attack bonus and the item has an
   * attack activity".
   */
  appliesWhen: (ctx: ActivityRuleContext) => boolean;
  /**
   * Run the check. Returns null when the check passes (no divergence) or
   * an AuditDivergence describing the mismatch. The framework appends
   * non-null returns to the action's divergence list.
   */
  check: (ctx: ActivityRuleContext) => AuditDivergence | null;
}

/**
 * Run all rules whose appliesWhen gate passes, returning the divergences
 * surfaced by their checks. Order is preserved so deterministic output.
 */
export function runActivityRules(
  rules: ActivityRule[],
  ctx: ActivityRuleContext,
): AuditDivergence[] {
  const out: AuditDivergence[] = [];
  for (const rule of rules) {
    if (!rule.appliesWhen(ctx)) continue;
    const div = rule.check(ctx);
    if (div) out.push(div);
  }
  return out;
}

/**
 * Phase 11 rule table. Starts with the Phase 10A condition-link rule ported
 * from compareSingleAction's inline check. Subsequent commits will port the
 * remaining inline checks (attack bonus/flat/type, save dc/ability, damage
 * parts, versatile, range, etc.) and add new rules (10A.7 targeting
 * completeness, attack→save chain detection, multiattack presence, etc.).
 */
export const ACTIVITY_RULES: ActivityRule[] = [
  // ----- attack activity -----------------------------------------------
  {
    id: 'attack.activity-present',
    label: 'parsed attack bonus requires an attack activity',
    appliesWhen: ctx => ctx.parsed.attackBonus !== undefined && !ctx.attackAct,
    check: ctx => ({
      field: 'attack.activity',
      reloaded: { bonus: ctx.parsed.attackBonus },
      foundry: 'no-attack-activity',
      status: 'missing',
      severity: 'critical',
    }),
  },
  {
    id: 'attack.bonus',
    label: 'attack bonus matches Reloaded printed value',
    appliesWhen: ctx => ctx.parsed.attackBonus !== undefined && !!ctx.attackAct,
    check: ctx => {
      const actual = parseAttackBonus(ctx.attackAct.attack?.bonus);
      if (actual === ctx.parsed.attackBonus) return null;
      return {
        field: 'attack.bonus',
        reloaded: ctx.parsed.attackBonus,
        foundry: actual,
        status: 'divergence',
        severity: 'critical',
      };
    },
  },
  {
    id: 'attack.flat',
    label: 'attack.flat must be true so Reloaded bonus is the FULL to-hit (else dnd5e adds ability+prof on top)',
    appliesWhen: ctx => ctx.parsed.attackBonus !== undefined && !!ctx.attackAct,
    check: ctx => {
      const flat = ctx.attackAct.attack?.flat;
      if (flat === true) return null;
      return {
        field: 'attack.flat',
        reloaded: true,
        foundry: !!flat,
        status: 'divergence',
        severity: 'critical',
        note: 'attack.flat=false will double-count ability+prof on top of Reloaded bonus',
      };
    },
  },
  {
    id: 'attack.type',
    label: 'attack type (melee/ranged) matches Reloaded',
    appliesWhen: ctx => ctx.parsed.attackBonus !== undefined && !!ctx.attackAct && !!ctx.parsed.attackType,
    check: ctx => {
      const actual = strOrNull(ctx.attackAct.attack?.type?.value);
      if (actual === ctx.parsed.attackType) return null;
      return {
        field: 'attack.type',
        reloaded: ctx.parsed.attackType,
        foundry: actual,
        status: 'divergence',
        severity: 'medium',
      };
    },
  },
  {
    id: 'attack.range.reach',
    label: 'melee reach matches Reloaded (with item-level fallback)',
    appliesWhen: ctx => ctx.parsed.attackBonus !== undefined && !!ctx.attackAct && ctx.parsed.reach !== undefined,
    check: ctx => {
      // dnd5e 5.x AttackActivity doesn't always persist a `reach` field on
      // the activity range — reach lives at item-level (system.range.reach).
      // Try activity first, fall back to item-level so a melee weapon whose
      // item.range.reach is correct isn't flagged as divergent just because
      // the activity didn't echo the value.
      const actual = numOrNull(ctx.attackAct.range?.reach) ?? numOrNull(ctx.item.system?.range?.reach);
      if (actual === ctx.parsed.reach) return null;
      return {
        field: 'attack.range.reach',
        reloaded: ctx.parsed.reach,
        foundry: actual,
        status: 'divergence',
        severity: 'medium',
      };
    },
  },
  {
    id: 'attack.range.value',
    label: 'ranged distance matches Reloaded (with item-level fallback)',
    appliesWhen: ctx => ctx.parsed.attackBonus !== undefined && !!ctx.attackAct && !!ctx.parsed.range,
    check: ctx => {
      const actual = numOrNull(ctx.attackAct.range?.value) ?? numOrNull(ctx.item.system?.range?.value);
      if (actual === ctx.parsed.range!.normal) return null;
      return {
        field: 'attack.range.value',
        reloaded: ctx.parsed.range!.normal,
        foundry: actual,
        status: 'divergence',
        severity: 'medium',
      };
    },
  },
  {
    id: 'attack.range.long',
    label: 'ranged long-range matches Reloaded',
    appliesWhen: ctx =>
      ctx.parsed.attackBonus !== undefined && !!ctx.attackAct
      && !!ctx.parsed.range && ctx.parsed.range.long !== undefined,
    check: ctx => {
      const actual = numOrNull(ctx.attackAct.range?.long) ?? numOrNull(ctx.item.system?.range?.long);
      if (actual === ctx.parsed.range!.long) return null;
      return {
        field: 'attack.range.long',
        reloaded: ctx.parsed.range!.long,
        foundry: actual,
        status: 'divergence',
        severity: 'medium',
      };
    },
  },

  // ----- versatile damage (item-level) ---------------------------------
  {
    id: 'damage.versatile',
    label: 'parsed versatile damage written to system.damage.versatile.custom',
    appliesWhen: ctx => !!ctx.parsed.versatile,
    check: ctx => checkVersatile(ctx),
  },

  // ----- save activity -------------------------------------------------
  {
    id: 'save.activity-present',
    label: 'parsed save requires a save activity',
    appliesWhen: ctx => !!ctx.parsed.save && !ctx.saveAct,
    check: ctx => ({
      field: 'save.activity',
      reloaded: { dc: ctx.parsed.save!.dc, ability: ctx.parsed.save!.ability },
      foundry: 'no-save-activity',
      status: 'missing',
      severity: 'critical',
    }),
  },
  {
    id: 'save.dc',
    label: 'save DC matches Reloaded printed value',
    appliesWhen: ctx => !!ctx.parsed.save && !!ctx.saveAct,
    check: ctx => {
      const actual = parseDc(ctx.saveAct.save?.dc?.formula);
      if (actual === ctx.parsed.save!.dc) return null;
      return {
        field: 'save.dc',
        reloaded: ctx.parsed.save!.dc,
        foundry: actual,
        status: 'divergence',
        severity: 'critical',
      };
    },
  },
  {
    id: 'save.ability',
    label: 'save ability matches Reloaded',
    appliesWhen: ctx => !!ctx.parsed.save && !!ctx.saveAct,
    check: ctx => {
      const abilityArr = Array.isArray(ctx.saveAct.save?.ability)
        ? ctx.saveAct.save.ability
        : (ctx.saveAct.save?.ability ? [ctx.saveAct.save.ability] : []);
      const actual = abilityArr.length > 0 ? String(abilityArr[0]).toLowerCase() : null;
      if (actual === ctx.parsed.save!.ability) return null;
      return {
        field: 'save.ability',
        reloaded: ctx.parsed.save!.ability,
        foundry: actual,
        status: 'divergence',
        severity: 'critical',
      };
    },
  },
  {
    id: 'save.condition',
    label: 'save → effect link applies the parsed condition on save fail',
    appliesWhen: ctx => !!ctx.parsed.save && !!ctx.parsed.condition && !!ctx.saveAct,
    check: ctx => checkSaveCondition(ctx),
  },

  // ----- damage parts (target activity depends on parsed shape) -----
  {
    id: 'damage.activity-present',
    label: 'parsed damage requires a target activity (attack/save/damage)',
    appliesWhen: ctx => ctx.parsed.damage.length > 0 && !damageTargetActivity(ctx),
    check: ctx => ({
      field: 'damage.activity',
      reloaded: ctx.parsed.damage,
      foundry: 'no-target-activity',
      status: 'missing',
      severity: 'critical',
    }),
  },
  {
    id: 'damage.parts',
    label: 'damage parts (formula + type) match Reloaded',
    appliesWhen: ctx => ctx.parsed.damage.length > 0 && !!damageTargetActivity(ctx),
    check: ctx => {
      const target = damageTargetActivity(ctx)!;
      const actualParts = (target.damage?.parts ?? []) as any[];
      const reloadedSet = new Set(ctx.parsed.damage.map(d => normDamageKey(d.formula, d.type)));
      const foundrySet = new Set<string>();
      for (const p of actualParts) {
        const formula = p?.custom?.enabled && p?.custom?.formula
          ? String(p.custom.formula)
          : reconstructFormula(p);
        const types = Array.isArray(p?.types) ? p.types : (p?.types ? Object.keys(p.types) : []);
        const type = types.length > 0 ? String(types[0]).toLowerCase() : '';
        if (formula) foundrySet.add(normDamageKey(formula, type));
      }
      const missing = [...reloadedSet].filter(k => !foundrySet.has(k));
      const extra = [...foundrySet].filter(k => !reloadedSet.has(k));
      if (missing.length === 0 && extra.length === 0) return null;
      return {
        field: 'damage.parts',
        reloaded: [...reloadedSet],
        foundry: [...foundrySet],
        status: 'divergence',
        severity: 'critical',
        note: `missing=${missing.join('|')} extra=${extra.join('|')}`,
      };
    },
  },
  {
    id: 'damage.includeBase',
    label: 'attack-activity damage.includeBase must be false (else dnd5e adds weapon base die on top)',
    appliesWhen: ctx =>
      ctx.parsed.damage.length > 0
      && ctx.parsed.attackBonus !== undefined
      && !!ctx.attackAct,
    check: ctx => {
      const includeBase = ctx.attackAct.damage?.includeBase;
      if (includeBase === false) return null;
      return {
        field: 'damage.includeBase',
        reloaded: false,
        foundry: includeBase === undefined ? null : !!includeBase,
        status: 'divergence',
        severity: 'critical',
        note: 'damage.includeBase!=false will add weapon base die on top of Reloaded damage',
      };
    },
  },

  // ----- description prefix (low-severity sync check) ------------------
  {
    id: 'description',
    label: 'item description prefix matches Reloaded prose',
    appliesWhen: ctx => !!ctx.action.description,
    check: ctx => {
      const actorText = stripHtml(String(ctx.item.system?.description?.value ?? ''));
      const reloadedText = ctx.action.description.trim();
      const actorPrefix = actorText.slice(0, 80).trim().toLowerCase();
      const reloadedPrefix = reloadedText.slice(0, 80).trim().toLowerCase();
      if (actorPrefix === reloadedPrefix) return null;
      return {
        field: 'description',
        reloaded: reloadedPrefix,
        foundry: actorPrefix,
        status: 'divergence',
        severity: 'low',
        note: 'description prefix differs (likely SRD text not synced)',
      };
    },
  },

  // ----- Phase 10A.7 targeting completeness ----------------------------
  // Save activities with parsed AOE templates need target.template.{type,size}
  // set, otherwise Foundry/Midi can't prompt the GM to draw a Measured
  // Template. Without it, "Measured Template Prompt" on the IDENTITY tab
  // does nothing because there's no shape configured.
  {
    id: 'target.template',
    label: 'parsed AOE template (radius/cone/line/etc.) written to activity target.template',
    appliesWhen: ctx =>
      !!ctx.parsed.targetShape?.template
      && (!!ctx.saveAct || !!ctx.damageAct),
    check: ctx => {
      const target = ctx.saveAct ?? ctx.damageAct;
      const tpl = ctx.parsed.targetShape!.template!;
      const actualType = strOrNull(target.target?.template?.type);
      const actualSize = numOrNull(target.target?.template?.size);
      if (actualType === tpl.shape && actualSize === tpl.size) return null;
      return {
        field: 'target.template',
        reloaded: { type: tpl.shape, size: tpl.size },
        foundry: { type: actualType, size: actualSize },
        status: 'divergence',
        severity: 'medium',
        note: `parsed targetShape.template (${tpl.shape}/${tpl.size}ft) didn't land on activity — Midi won't prompt for a Measured Template`,
      };
    },
  },
  {
    id: 'target.affects',
    label: 'parsed target affects (type + optional count) written to activity target.affects',
    appliesWhen: ctx =>
      !!ctx.parsed.targetShape?.affects
      && (!!ctx.saveAct || !!ctx.attackAct || !!ctx.damageAct),
    check: ctx => {
      const target = ctx.saveAct ?? ctx.attackAct ?? ctx.damageAct;
      const aff = ctx.parsed.targetShape!.affects!;
      const actualType = strOrNull(target.target?.affects?.type);
      const actualCount = target.target?.affects?.count;
      // count is optional — only enforce when parsed includes it
      const typeOK = actualType === aff.type;
      const countOK = aff.count === undefined || actualCount === aff.count;
      if (typeOK && countOK) return null;
      return {
        field: 'target.affects',
        reloaded: aff,
        foundry: { type: actualType, count: actualCount },
        status: 'divergence',
        severity: 'medium',
        note: `parsed affects (${aff.type}${aff.count ? `, count=${aff.count}` : ''}) didn't land on activity`,
      };
    },
  },

  // ----- Phase 11.2 cross-activity chain detection ----------------------
  // Bite-style items have both an attack activity (Hit:) and a save
  // activity (DC X save vs being knocked prone / poisoned / etc.). For
  // the save to fire automatically after the attack hits, the attack's
  // triggeredActivityId must reference the save's _id. Without the chain
  // wired, the GM has to manually click the save activity after every
  // attack roll. Per Midi-QOL README "Triggered Activities" section.
  {
    id: 'attack-save.chain',
    label: 'item with both attack + save activities should chain attack → save (triggeredActivityId)',
    appliesWhen: ctx =>
      !!ctx.attackAct && !!ctx.saveAct
      && ctx.parsed.attackBonus !== undefined && !!ctx.parsed.save,
    check: ctx => {
      const triggered = strOrNull(ctx.attackAct.midiProperties?.triggeredActivityId);
      const saveId = strOrNull(ctx.saveAct._id ?? ctx.saveAct.id);
      // 'none' is dnd5e's default placeholder for unset triggers; treat as missing
      if (triggered && triggered !== 'none' && triggered === saveId) return null;
      return {
        field: 'attack-save.chain',
        reloaded: { triggeredActivityId: saveId },
        foundry: { triggeredActivityId: triggered },
        status: 'divergence',
        severity: 'medium',
        note: 'attack activity should set midiProperties.triggeredActivityId to the save activity\'s _id so the save auto-fires after a hit (Midi-QOL Triggered Activities pattern)',
      };
    },
  },
];

/**
 * Where do parsed damage parts live? attack-bonus → attack activity (Hit:);
 * save-only prose → save activity ("must succeed... or take 2d6"); else
 * the dedicated damage activity (rare: AoE-only effects).
 */
function damageTargetActivity(ctx: ActivityRuleContext): any | undefined {
  const damageGoesOnAttack = ctx.parsed.attackBonus !== undefined;
  const damageGoesOnSave = !damageGoesOnAttack && !!ctx.parsed.save;
  return damageGoesOnAttack ? ctx.attackAct : (damageGoesOnSave ? ctx.saveAct : ctx.damageAct);
}

function checkVersatile(ctx: ActivityRuleContext): AuditDivergence | null {
  const { parsed, item } = ctx;
  const versatile = item.system?.damage?.versatile;
  const customEnabled = versatile?.custom?.enabled === true;
  const customFormula = versatile?.custom?.formula;
  if (!customEnabled || !customFormula) {
    return {
      field: 'damage.versatile',
      reloaded: parsed.versatile,
      foundry: customEnabled ? { formula: customFormula ?? null } : 'not-set',
      status: 'divergence',
      severity: 'medium',
      note: 'Reloaded prose has a versatile alternative (e.g. "or 2d10+4 if two-handed") but item.system.damage.versatile.custom is not set; sheet won\'t expose the alternate damage roll.',
    };
  }
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const formulaMatch = norm(String(customFormula)) === norm(parsed.versatile!.formula);
  if (!formulaMatch) {
    return {
      field: 'damage.versatile.formula',
      reloaded: parsed.versatile!.formula,
      foundry: customFormula,
      status: 'divergence',
      severity: 'medium',
    };
  }
  const versatileTypes = Array.isArray(versatile?.types) ? versatile.types : [];
  const typeMatch = versatileTypes.length > 0
    && String(versatileTypes[0]).toLowerCase() === parsed.versatile!.type.toLowerCase();
  if (!typeMatch) {
    return {
      field: 'damage.versatile.type',
      reloaded: parsed.versatile!.type,
      foundry: versatileTypes,
      status: 'divergence',
      severity: 'medium',
    };
  }
  return null;
}

function checkSaveCondition(ctx: ActivityRuleContext): AuditDivergence | null {
  const { parsed, item, saveAct } = ctx;
  const condition = parsed.condition!;

  const saveActEffects: any[] = Array.isArray(saveAct.effects) ? saveAct.effects : [];
  const linkedEffectIds: string[] = saveActEffects
    .map(e => (e && typeof e === 'object' ? e._id ?? e.id : null))
    .filter((id): id is string => typeof id === 'string');
  const inferStrictLinkMissingButData =
    linkedEffectIds.length === 0 && saveActEffects.length > 0;

  const effectsFieldType =
    item.effects === undefined ? 'undefined'
    : item.effects === null ? 'null'
    : Array.isArray(item.effects) ? `array[${(item.effects as any[]).length}]`
    : `not-array(${typeof item.effects})`;
  const itemEffectsArr: any[] = Array.isArray(item.effects) ? item.effects : [];
  const itemEffectsById = new Map<string, any>();
  for (const eff of itemEffectsArr) {
    const id = eff?._id ?? eff?.id;
    if (typeof id === 'string') itemEffectsById.set(id, eff);
  }
  const itemEffectsSummary = itemEffectsArr.map(e => ({
    _id: e?._id ?? e?.id,
    name: e?.name,
    statuses: Array.isArray(e?.statuses) ? e.statuses : (e?.statuses ? `not-array(${typeof e.statuses})` : []),
    transfer: e?.transfer,
  }));
  const linkedEffects = linkedEffectIds
    .map(id => itemEffectsById.get(id))
    .filter(Boolean);
  const hasMatchingStatus = linkedEffects.some(eff => {
    const statuses = Array.isArray(eff?.statuses) ? eff.statuses.map(String) : [];
    return statuses.includes(condition.type);
  });
  const itemHasMatchingStatusEffect = itemEffectsArr.some(eff =>
    (Array.isArray(eff?.statuses) ? eff.statuses.map(String) : []).includes(condition.type),
  );
  const inferredLinkOK = inferStrictLinkMissingButData && itemHasMatchingStatusEffect;

  if (hasMatchingStatus || inferredLinkOK) return null;

  let note: string;
  let foundry: any;
  if (saveActEffects.length === 0) {
    note = `save activity effects[] is empty; build pipeline did not attach a condition link`;
    foundry = { kind: 'no-link-entry', itemEffectsField: effectsFieldType, itemEffects: itemEffectsSummary };
  } else if (linkedEffectIds.length === 0) {
    note = `save activity has effects[] entry but no item-side effect with statuses: ['${condition.type}'] exists; build pipeline didn't create the linked effect`;
    foundry = {
      effectsEntries: saveActEffects.length,
      missingIds: true,
      itemHasMatchingStatusEffect: false,
      itemEffectsField: effectsFieldType,
      itemEffects: itemEffectsSummary,
    };
  } else if (linkedEffects.length === 0) {
    note = `save activity links effect ids [${linkedEffectIds.join(', ')}] but no item-side effect with those ids exists`;
    foundry = {
      linkedIds: linkedEffectIds,
      itemEffectIds: [...itemEffectsById.keys()],
      itemEffectsField: effectsFieldType,
    };
  } else {
    note = `linked effect(s) present but none carries statuses: ['${condition.type}']`;
    foundry = { linkedEffects: linkedEffects.map(e => ({ _id: e._id ?? e.id, statuses: e.statuses ?? [] })) };
  }

  return {
    field: 'save.condition',
    reloaded: { type: condition.type },
    foundry,
    status: 'divergence',
    severity: 'medium',
    note,
  };
}

function compareSingleAction(
  action: StatblockFeature,
  item: ActorItemSnapshot,
  activities: any[],
): AuditDivergence[] {
  const out: AuditDivergence[] = [];
  const parsed = action.parsed;

  // Locate activities by type. A single item can have multiple of the same
  // type (rare); we match the first of each.
  const attackAct = activities.find(a => a?.type === 'attack');
  const saveAct = activities.find(a => a?.type === 'save');
  const damageAct = activities.find(a => a?.type === 'damage');

  // Phase 11: ALL per-activity checks now live in ACTIVITY_RULES (attack
  // bonus/flat/type/range, save dc/ability/condition, damage parts/
  // includeBase, versatile, description). Rule pass at the end of this
  // function fires them via runActivityRules. compareSingleAction's body
  // is now just ctx-build + rule-pass + filter.

  // Phase 11: declarative rule pass. Every per-activity check is now a rule
  // in ACTIVITY_RULES; the body below is just ctx-build + rule-pass.
  const ctx: ActivityRuleContext = {
    action,
    parsed,
    item,
    activities,
    attackAct,
    saveAct,
    damageAct,
  };
  out.push(...runActivityRules(ACTIVITY_RULES, ctx));

  // Filter out the matches — caller's status field indicates overall.
  return out.filter(d => d.status !== 'match');
}

// ----- small helpers ---------------------------------------------------------

function pushCmp(
  out: AuditDivergence[],
  field: string,
  reloaded: unknown,
  foundry: unknown,
  severity: Severity,
  extra: { note?: string } = {},
): void {
  const status: Status = reloaded === foundry ? 'match' : 'divergence';
  out.push({ field, reloaded, foundry, status, severity, ...extra });
}

function numOrNull(v: any): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return null;
}

function strOrNull(v: any): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function caseInsensitiveEq(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

function parseAttackBonus(raw: any): number | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/([+-]?\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseDc(raw: any): number | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function reconstructFormula(part: any): string {
  if (typeof part?.number === 'number' && typeof part?.denomination === 'number' && part.denomination > 0) {
    const bonus = typeof part.bonus === 'number' ? (part.bonus >= 0 ? `+${part.bonus}` : String(part.bonus)) : '';
    return `${part.number}d${part.denomination}${bonus}`;
  }
  return '';
}

function normDamageKey(formula: string, type: string): string {
  const f = formula.replace(/\s+/g, '').toLowerCase();
  const t = (type ?? '').toLowerCase();
  return `${f}|${t}`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// ----- tool wrapper class ----------------------------------------------------

export interface AuditActorToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class AuditActorTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: AuditActorToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'AuditActorTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'audit-actor',
        description:
          'Read-only diff between a Foundry actor and a CoS Reloaded source. Returns a structured divergence list with severity (critical = combat math wrong: HP/AC/abilities/save DC/attack bonus/damage; medium = printed/derived value off: skills, senses, ranges, traits, prof bonus, CR; low = description text). Use after create-actor to verify the build landed clean, or on a hand-curated actor to spot mismatches. Inputs: actorId OR actorName, plus one of reloaded_source, file_path+creature_name, OR actor_only=true (skips comparison; just reports actor-side sanity).',
        inputSchema: {
          type: 'object',
          properties: {
            actorId: {
              type: 'string',
              description: 'ID of the actor to audit. Use this OR actorName.',
            },
            actorName: {
              type: 'string',
              description: 'Name of the actor to audit. Use this OR actorId.',
            },
            reloaded_source: {
              type: 'string',
              description: 'Markdown containing exactly one <div class="statblock"> block. Use this OR file_path+creature_name OR actor_only.',
            },
            file_path: {
              type: 'string',
              description: 'Absolute path to a Reloaded markdown file. Requires creature_name.',
            },
            creature_name: {
              type: 'string',
              description: 'Heading text for the statblock (matches `### <creature_name>`).',
            },
            actor_only: {
              type: 'boolean',
              description: 'Skip the Reloaded comparison and return just an actor-side snapshot (item count, missing required fields).',
            },
          },
        },
      },
    ];
  }

  async handleAuditActor(args: any): Promise<any> {
    const schema = z.object({
      actorId: z.string().optional(),
      actorName: z.string().optional(),
      reloaded_source: z.string().optional(),
      file_path: z.string().optional(),
      creature_name: z.string().optional(),
      actor_only: z.boolean().optional(),
    }).refine(d => d.actorId || d.actorName, {
      message: 'Provide actorId or actorName',
    }).refine(d =>
      d.actor_only || d.reloaded_source || (d.file_path && d.creature_name),
      { message: 'Provide reloaded_source, file_path+creature_name, or actor_only=true' },
    );
    const input = schema.parse(args);

    this.logger.info('audit-actor invoked', {
      actorId: input.actorId,
      actorName: input.actorName,
      hasSource: !!input.reloaded_source,
      filePath: input.file_path,
      creatureName: input.creature_name,
      actorOnly: !!input.actor_only,
    });

    try {
      // Resolve actor identifier — getCharacterInfo accepts either id or name
      // via the same `characterName` param; Volenta first form's code path
      // proves that.
      const identifier = input.actorId ?? input.actorName!;
      const actorRaw: any = await this.foundryClient.query(
        'foundry-forge-mcp.getCharacterInfo',
        { characterName: identifier },
      );
      const actor = this.normalizeActorSnapshot(actorRaw, identifier);

      if (input.actor_only) {
        return {
          success: true,
          actor: { id: actor.id, name: actor.name },
          mode: 'actor_only',
          snapshot: this.actorSnapshotSummary(actor),
        };
      }

      // Resolve markdown source.
      const markdown = await this.resolveSource(input);
      const sb = parseReloadedStatblock(markdown);
      this.logger.debug('audit-actor parsed', { name: sb.name, cr: sb.challenge });

      const audit = compareActor(actor, sb);

      return {
        success: true,
        actor: { id: actor.id, name: actor.name },
        parsed: {
          name: sb.name,
          challenge: sb.challenge,
          ac: sb.ac,
          hp: sb.hp.avg,
          traits: sb.traits.length,
          actionsTotal: sb.actions.length + sb.bonusActions.length + sb.reactions.length
            + sb.legendaryActions.length + sb.lairActions.length,
        },
        audit,
        guidance: this.buildGuidance(audit),
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'audit-actor', 'actor audit');
    }
  }

  private normalizeActorSnapshot(raw: any, identifier: string): ActorSnapshot {
    if (!raw) {
      throw new Error(`Actor "${identifier}" not found via getCharacterInfo`);
    }
    // getCharacterInfo's response wraps the actor as {id, name, system, items}
    // at the top level (or sometimes under .character or .actor).
    const inner = raw.character ?? raw.actor ?? raw;
    const id = inner.id ?? inner._id ?? identifier;
    const name = inner.name ?? identifier;
    const system = inner.system ?? {};
    const items: ActorItemSnapshot[] = Array.isArray(inner.items) ? inner.items : [];
    // v0.1.20: pass through portrait + token image URLs so the snapshot
    // surfaces them. Module-side data-access also populates these in v0.1.20.
    const img = inner.img;
    const tokenImg = inner.tokenImg;
    const snapshot: ActorSnapshot = { id, name, system, items };
    if (img) snapshot.img = img;
    if (tokenImg) snapshot.tokenImg = tokenImg;
    return snapshot;
  }

  private actorSnapshotSummary(actor: ActorSnapshot): Record<string, any> {
    const sys = actor.system ?? {};
    const items = actor.items ?? [];
    const itemTypes: Record<string, number> = {};
    for (const it of items) {
      const t = String(it.type ?? 'unknown');
      itemTypes[t] = (itemTypes[t] ?? 0) + 1;
    }
    return {
      hp: { max: sys.attributes?.hp?.max, value: sys.attributes?.hp?.value },
      ac: { flat: sys.attributes?.ac?.flat, value: sys.attributes?.ac?.value, calc: sys.attributes?.ac?.calc },
      abilities: ['str', 'dex', 'con', 'int', 'wis', 'cha'].reduce<Record<string, any>>((acc, ab) => {
        acc[ab] = sys.abilities?.[ab]?.value;
        return acc;
      }, {}),
      cr: sys.details?.cr,
      itemCount: items.length,
      itemTypes,
      // v0.1.20: portrait + token texture URLs. These are what the
      // portrait_canon-aware tools (apply_npc_portrait_to_foundry,
      // sync_npc_portrait) read or set. Surfacing them in the snapshot lets
      // audits catch the case where a build inherited the wrong compendium
      // base's default art (e.g. DDB Noble png on a beneos-tagged Wachter
      // sibling) — silently invisible before v0.1.20.
      img: actor.img ?? null,
      tokenImg: actor.tokenImg ?? null,
    };
  }

  private buildGuidance(audit: AuditResult): string[] {
    const out: string[] = [];
    if (audit.summary.criticalDivergences === 0) {
      out.push('Zero critical divergences — combat math should be correct at the table.');
    } else {
      out.push(`${audit.summary.criticalDivergences} critical divergences — these affect combat math and should be fixed before play.`);
    }
    if (audit.summary.mediumDivergences > 0) {
      out.push(`${audit.summary.mediumDivergences} medium divergences — printed/derived values diverge but combat plays correctly.`);
    }
    if (audit.summary.lowDivergences > 0) {
      out.push(`${audit.summary.lowDivergences} low divergences — descriptions / cosmetic.`);
    }
    if (audit.features.missingFromActor.length > 0) {
      out.push(`Missing features: ${audit.features.missingFromActor.join(', ')}`);
    }
    const missingActions = audit.actions.filter(a => a.status === 'missing-item').map(a => a.name);
    if (missingActions.length > 0) {
      out.push(`Missing action items: ${missingActions.join(', ')}`);
    }
    return out;
  }

  private async resolveSource(input: {
    reloaded_source?: string | undefined;
    file_path?: string | undefined;
    creature_name?: string | undefined;
  }): Promise<string> {
    if (input.reloaded_source) return input.reloaded_source;
    if (!input.file_path || !input.creature_name) {
      throw new Error('Missing source input (defense in depth — should be caught by schema)');
    }
    const content = await readFile(input.file_path, 'utf8');
    return extractStatblockSection(content, input.creature_name, input.file_path);
  }
}
