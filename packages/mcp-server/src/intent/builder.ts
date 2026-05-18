// Phase 0 (Arc H gap-closure plan 2026-05-17) — canonical Reloaded-source → ActorIntent
// orchestrator. Composes the existing pure parsers + adapters into a single entry point
// so create-actor (build) and audit-actor (verify) can share the same canonical artifact.
//
// Today both create-actor and audit-actor call parseReloadedStatblock(markdown) and
// then re-derive what the actor SHOULD look like in their own loops. Two parsers, one
// source — silent drift potential. The Arc H Gallows Speaker session surfaced this:
// includeBase=true silently kept Specter 2d6 fire on Foretelling Touch, save activities
// modeled as attack activities (Wisplight Flare), save-gated damage rolling on every hit
// (Ba'al Verzi Dagger). The audit's strict shape-check flagged "no-target-activity" on
// items that fire correctly while missing the activities that don't fire at all.
//
// This module is the FIRST step toward closing that gap: a pure function that emits the
// canonical `ActorIntent` from a Reloaded statblock div. Downstream:
//   - audit-actor (Phase 2) compares each Foundry item's labels.toHit / labels.damages
//     against the activity surface declared by the intent.
//   - parse-reloaded-source MCP tool (Phase 0+) exposes this to cos-pipeline so the
//     catalog can render the expected activity manifest per NPC at Phase A.
//   - create-actor (Mode A) optionally consumes the pre-built intent instead of
//     re-parsing — single source of truth.
//
// Pure function. No Foundry deps. No network. Composition over:
//   parseReloadedStatblock (parsers/reloaded-statblock.ts) — markdown → ReloadedStatblock
//   parseActionDescription (parsers/action-description.ts)  — per-feature prose → ParsedAction
//                                                              (already called by parseReloadedStatblock,
//                                                              cached on StatblockFeature.parsed)
//   parsedActionToIntent (intent/parsed-to-intent.ts)       — ParsedAction → ActionIntent
//   resolveTraitTemplate (tools/create-actor.ts)            — trait name → TraitTemplate or null
//   stripUsageSuffix (tools/create-actor.ts)                — "Name (Recharge 5-6)" → {stem, marker}

import {
  parseReloadedStatblock,
  type ReloadedStatblock,
  type StatblockFeature,
} from '../parsers/reloaded-statblock.js';
import { parsedActionToIntent } from './parsed-to-intent.js';
import type {
  ActionIntent,
  ActorIntent,
  ActorAbilityScores,
  ActorACIntent,
  ActorHPIntent,
  ActorSensesIntent,
  ActorSpeedIntent,
  ConditionType,
  CreatureSize,
  TraitIntent,
  TraitIntentKind,
} from './activity-intent.js';
import { resolveTraitTemplate, stripUsageSuffix } from '../tools/create-actor.js';

const CREATURE_SIZE_MAP: Record<string, CreatureSize> = {
  tiny: 'Tiny',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  huge: 'Huge',
  gargantuan: 'Gargantuan',
};

const STANDARD_CONDITION_TYPES: ReadonlySet<ConditionType> = new Set([
  'blinded',
  'charmed',
  'deafened',
  'frightened',
  'grappled',
  'incapacitated',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
]);

const TRAIT_NAME_TO_KIND: Record<string, TraitIntentKind> = {
  'Pack Tactics': 'pack-tactics',
  'Sunlight Sensitivity': 'sunlight-sensitivity',
  'Sunlight Hypersensitivity': 'sunlight-hypersensitivity',
  Regeneration: 'regeneration',
  'Magic Resistance': 'magic-resistance',
};

/**
 * Top-level entry: raw Reloaded markdown → canonical ActorIntent.
 *
 * Equivalent to `statblockToIntent(parseReloadedStatblock(markdown))`. Throws if the
 * markdown doesn't contain a `<div class="statblock">` block (delegates to the parser).
 */
export function parseReloadedSource(markdown: string): ActorIntent {
  const sb = parseReloadedStatblock(markdown);
  return statblockToIntent(sb);
}

/**
 * Roll up a parsed ReloadedStatblock into the canonical ActorIntent shape. Pure;
 * exposed separately so callers that already have a ReloadedStatblock (audit-actor's
 * existing inline parse path) can convert without re-parsing the markdown.
 */
export function statblockToIntent(sb: ReloadedStatblock): ActorIntent {
  const intent: ActorIntent = {
    name: sb.name,
    traits: sb.traits.map(featureToTraitIntent),
    actions: sb.actions.map(featureToActionIntent),
    bonusActions: sb.bonusActions.map(featureToActionIntent),
    reactions: sb.reactions.map(featureToActionIntent),
    legendaryActions: sb.legendaryActions.map(featureToActionIntent),
    lairActions: sb.lairActions.map(featureToActionIntent),
  };

  // Identity
  const size = normalizeSize(sb.size);
  if (size) intent.size = size;
  if (sb.type) intent.type = sb.type;
  if (sb.subtype) intent.subtype = sb.subtype;
  if (sb.alignment) intent.alignment = sb.alignment;

  // Combat fundamentals
  if (typeof sb.ac === 'number') {
    const ac: ActorACIntent = { value: sb.ac };
    if (sb.acNote) ac.note = sb.acNote;
    intent.ac = ac;
  }
  if (sb.hp && typeof sb.hp.avg === 'number') {
    const hp: ActorHPIntent = { max: sb.hp.avg };
    if (sb.hp.formula) hp.formula = sb.hp.formula;
    intent.hp = hp;
  }
  const speed = normalizeSpeed(sb.speed, sb.speedText);
  if (speed) intent.speed = speed;

  // Abilities + proficiencies
  const abilities = normalizeAbilities(sb.abilities);
  if (abilities) intent.abilities = abilities;
  const saves = normalizeSaves(sb.saves);
  if (saves) intent.saves = saves;
  if (sb.skills && Object.keys(sb.skills).length > 0) {
    intent.skills = sb.skills;
  }

  // Senses
  const senses = normalizeSenses(sb);
  if (senses) intent.senses = senses;

  // Defenses (list-shaped fields; ReloadedStatblock has them as comma-joined strings)
  const damageResistances = splitList(sb.damageResistances);
  if (damageResistances.length) intent.damageResistances = damageResistances;
  const damageImmunities = splitList(sb.damageImmunities);
  if (damageImmunities.length) intent.damageImmunities = damageImmunities;
  const damageVulnerabilities = splitList(sb.damageVulnerabilities);
  if (damageVulnerabilities.length) intent.damageVulnerabilities = damageVulnerabilities;
  const conditionImmunities = splitConditionList(sb.conditionImmunities);
  if (conditionImmunities.length) intent.conditionImmunities = conditionImmunities;

  // Languages
  const languages = splitList(sb.languages);
  if (languages.length) intent.languages = languages;

  // Challenge — prefer the numeric form when the parser extracted one. Fall
  // back to a "CR N" prefix strip (the parser's parseChallenge expects bare
  // numerics like "21" but Reloaded prints "CR 21"). Last resort: keep the
  // raw string (e.g. "21, or 19 in sunlight").
  if (sb.challengeNumeric !== null && sb.challengeNumeric !== undefined) {
    intent.cr = sb.challengeNumeric;
  } else if (sb.challenge) {
    const cr = parseCRString(sb.challenge);
    intent.cr = cr;
  }
  if (sb.proficiencyBonus !== null && sb.proficiencyBonus !== undefined) {
    intent.proficiencyBonus = sb.proficiencyBonus;
  }

  return intent;
}

/**
 * Convert one parsed Reloaded feature into a canonical ActionIntent.
 * Reuses parsedActionToIntent (the Phase 12.0 adapter) which already covers
 * the attack/save/damage routing rules tested by create-actor.
 */
export function featureToActionIntent(feature: StatblockFeature): ActionIntent {
  const { stem, marker } = stripUsageSuffix(feature.name);
  // Name-side marker wins over parser-side usage when both exist —
  // matches today's buildScratchActionItem behavior in create-actor.
  const usage = marker ?? feature.parsed.usage;
  return parsedActionToIntent({
    name: stem,
    description: feature.description,
    usage,
    parsed: feature.parsed,
  });
}

/**
 * Convert one parsed Reloaded trait into a canonical TraitIntent.
 *
 * Classification:
 *   - Name resolves via `resolveTraitTemplate` → emit registered kind
 *     (pack-tactics / sunlight-* / regeneration / magic-resistance)
 *   - Otherwise → description-only
 *
 * `custom` TraitIntents are never emitted by the parser — they're caller-supplied
 * via Mode D `traits_intent` for traits the registry doesn't cover. The builder
 * just classifies what's in the statblock; custom upgrades happen at the override
 * layer.
 */
export function featureToTraitIntent(feature: StatblockFeature): TraitIntent {
  const tpl = resolveTraitTemplate(feature.name);
  const kind: TraitIntentKind = tpl ? TRAIT_NAME_TO_KIND[tpl.name] ?? 'description-only' : 'description-only';
  return {
    kind,
    name: feature.name,
    description: feature.description,
  };
}

// ---------- normalizers ---------------------------------------------------------

function normalizeSize(rawSize: string): CreatureSize | undefined {
  const lc = rawSize.trim().toLowerCase();
  return CREATURE_SIZE_MAP[lc];
}

function normalizeSpeed(
  speed: Record<string, number>,
  speedText: string,
): ActorSpeedIntent | undefined {
  const out: ActorSpeedIntent = {};
  if (typeof speed.walk === 'number') out.walk = speed.walk;
  if (typeof speed.fly === 'number') out.fly = speed.fly;
  if (typeof speed.swim === 'number') out.swim = speed.swim;
  if (typeof speed.climb === 'number') out.climb = speed.climb;
  if (typeof speed.burrow === 'number') out.burrow = speed.burrow;
  // Hover detection — Reloaded prints "fly 40 ft. (hover)" in speedText.
  if (typeof out.fly === 'number' && /hover/i.test(speedText)) {
    out.hover = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const ABILITY_KEY_LIST: ReadonlyArray<keyof ActorAbilityScores> = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

function normalizeSaves(
  saves: Record<string, number> | undefined | null,
): Partial<Record<keyof ActorAbilityScores, number>> | undefined {
  if (!saves) return undefined;
  const out: Partial<Record<keyof ActorAbilityScores, number>> = {};
  for (const key of ABILITY_KEY_LIST) {
    const v = saves[key];
    if (typeof v === 'number') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeAbilities(
  abilities: ReloadedStatblock['abilities'],
): ActorAbilityScores | undefined {
  if (!abilities) return undefined;
  const keys: (keyof ActorAbilityScores)[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const out: Partial<ActorAbilityScores> = {};
  for (const key of keys) {
    const ab = abilities[key];
    if (ab && typeof ab.score === 'number') out[key] = ab.score;
  }
  // Only emit if all six populated — partial abilities aren't a valid statblock.
  return keys.every(k => typeof out[k] === 'number') ? (out as ActorAbilityScores) : undefined;
}

function normalizeSenses(sb: ReloadedStatblock): ActorSensesIntent | undefined {
  const out: ActorSensesIntent = {};
  const text = sb.sensesText ?? '';
  const dark = text.match(/darkvision\s+(\d+)\s*ft/i);
  if (dark) out.darkvision = parseInt(dark[1], 10);
  const blind = text.match(/blindsight\s+(\d+)\s*ft/i);
  if (blind) out.blindsight = parseInt(blind[1], 10);
  const true_ = text.match(/truesight\s+(\d+)\s*ft/i);
  if (true_) out.truesight = parseInt(true_[1], 10);
  const tremor = text.match(/tremorsense\s+(\d+)\s*ft/i);
  if (tremor) out.tremorsense = parseInt(tremor[1], 10);
  if (typeof sb.passivePerception === 'number') {
    out.passivePerception = sb.passivePerception;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Best-effort CR string normalization. Reloaded prints "CR 11", "CR 1/4",
 * "CR 21, or 19 when fought in sunlight". The underlying parseChallenge
 * regex requires a bare digit prefix, so when challengeNumeric is null we
 * strip an optional "CR " prefix and try again, then fall back to the raw
 * string for ActorIntent.cr (which permits string | number).
 */
function parseCRString(raw: string): number | string {
  const trimmed = raw.trim();
  // "CR 11" / "Challenge 11"
  const prefixed = trimmed.match(/^(?:CR|Challenge)\s+(\d+)(?:\/(\d+))?\s*(?:[,(]|$)/i);
  if (prefixed) {
    const numerator = parseInt(prefixed[1]!, 10);
    if (prefixed[2]) return numerator / parseInt(prefixed[2], 10);
    return numerator;
  }
  // Bare "11" / "1/4" — defer to the same logic
  const bare = trimmed.match(/^(\d+)(?:\/(\d+))?\s*(?:[,(]|$)/);
  if (bare) {
    const n = parseInt(bare[1]!, 10);
    return bare[2] ? n / parseInt(bare[2], 10) : n;
  }
  return trimmed;
}

function splitList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Split a condition-immunity list into ConditionType-enum entries. Items that
 * aren't standard 5e conditions ("dazed", "cursed", custom homebrew) are dropped
 * here — the audit can flag them separately if a creature actually needs custom
 * condition handling, but the canonical ActorIntent only carries standard types.
 */
function splitConditionList(raw: string | null | undefined): ConditionType[] {
  return splitList(raw)
    .map(s => s.toLowerCase() as ConditionType)
    .filter((c): c is ConditionType => STANDARD_CONDITION_TYPES.has(c));
}
