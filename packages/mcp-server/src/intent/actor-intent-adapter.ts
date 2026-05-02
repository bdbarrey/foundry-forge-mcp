// Phase 12.1.2 — ActorIntent → ReloadedStatblock adapter.
//
// Mode E on create-actor lets the orchestrating Claude session bypass the
// regex statblock parser entirely and emit a structured ActorIntent. The
// downstream pipeline (applyOverridesChunked, addItems, action loop) is
// unchanged; this adapter synthesizes the ReloadedStatblock-shape that
// pipeline expects. Action and trait sub-intents pass through to
// actions_intent / traits_intent override paths via the synthetic
// StatblockFeature entries (parsed-action stub is irrelevant when the
// override is set, which it always is for ActorIntent-built actors).

import type { ActorIntent } from './activity-intent.js';
import type {
  ReloadedStatblock,
  StatblockFeature,
  StatblockAbility,
  StatblockAbilities,
} from '../parsers/reloaded-statblock.js';
import type { ParsedAction, ConditionType } from '../parsers/action-description.js';

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

const SENSE_ORDER: Array<keyof NonNullable<ActorIntent['senses']>> = [
  'darkvision',
  'blindsight',
  'truesight',
  'tremorsense',
];

function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

function abScore(intent: ActorIntent, ab: typeof ABILITY_KEYS[number]): StatblockAbility {
  const score = intent.abilities?.[ab] ?? 10;
  return { score, mod: abilityMod(score) };
}

function buildAbilities(intent: ActorIntent): StatblockAbilities {
  return {
    str: abScore(intent, 'str'),
    dex: abScore(intent, 'dex'),
    con: abScore(intent, 'con'),
    int: abScore(intent, 'int'),
    wis: abScore(intent, 'wis'),
    cha: abScore(intent, 'cha'),
  };
}

function buildSpeedRecord(intent: ActorIntent): Record<string, number> {
  const out: Record<string, number> = {};
  if (intent.speed?.walk !== undefined) out.walk = intent.speed.walk;
  if (intent.speed?.swim !== undefined) out.swim = intent.speed.swim;
  if (intent.speed?.fly !== undefined) out.fly = intent.speed.fly;
  if (intent.speed?.climb !== undefined) out.climb = intent.speed.climb;
  if (intent.speed?.burrow !== undefined) out.burrow = intent.speed.burrow;
  // Default to walk:0 so downstream chunk-builders have at least one entry.
  if (Object.keys(out).length === 0) out.walk = 0;
  return out;
}

function buildSensesText(intent: ActorIntent): string {
  // Phase 0-3 pipeline parses sensesText via parseSenses() in create-actor.ts;
  // emit the canonical "darkvision 60 ft., passive Perception 13" rendering
  // that parser expects. Keeps Mode E + Mode A consistent without bypassing
  // parseSenses.
  if (!intent.senses) return '';
  const parts: string[] = [];
  for (const mode of SENSE_ORDER) {
    const v = intent.senses[mode];
    if (typeof v === 'number') parts.push(`${mode} ${v} ft.`);
  }
  if (typeof intent.senses.passivePerception === 'number') {
    parts.push(`passive Perception ${intent.senses.passivePerception}`);
  }
  return parts.join(', ');
}

function joinOrNull(arr?: string[]): string | null {
  if (!arr || arr.length === 0) return null;
  return arr.join(', ');
}

function joinConditionsOrNull(arr?: ConditionType[]): string | null {
  if (!arr || arr.length === 0) return null;
  return arr.join(', ');
}

function challengeFields(cr: ActorIntent['cr']): { challenge: string; challengeNumeric: number | null } {
  if (cr === undefined || cr === null) return { challenge: '', challengeNumeric: null };
  if (typeof cr === 'number') return { challenge: String(cr), challengeNumeric: cr };
  // String form: "1/4" → 0.25, "21" → 21, "21, or 19 in sunlight" → 21 (parse leading number).
  const s = cr.trim();
  const fraction = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (fraction) {
    const num = parseInt(fraction[1], 10);
    const den = parseInt(fraction[2], 10);
    return { challenge: s, challengeNumeric: den === 0 ? null : num / den };
  }
  const intMatch = s.match(/^(\d+(?:\.\d+)?)/);
  return {
    challenge: s,
    challengeNumeric: intMatch ? Number(intMatch[1]) : null,
  };
}

function emptyParsed(): ParsedAction {
  return { damage: [] };
}

/**
 * Build a synthetic StatblockFeature for an ActionIntent or TraitIntent.
 * The `parsed` field is a stub — when actor_intent runs through Mode A's
 * action loop, the per-action override (via actions_intent) is what the
 * writer consumes; the stub parsed never fires the parser path. Same for
 * traits going through traits_intent.
 *
 * Description is the canonical prose that lands in system.description.value.
 */
function feature(name: string, description: string): StatblockFeature {
  return { name, description, parsed: emptyParsed() };
}

/**
 * Synthesize a ReloadedStatblock from an ActorIntent. Lets Mode E reuse
 * the entire Phase 0-11 build pipeline (chunked overrides, trait add,
 * action loop with intent overrides) without modification.
 *
 * Convention: the caller of this adapter ALSO sets actions_intent +
 * traits_intent on the create-actor input from intent.actions / intent.traits.
 * That override path is what the action loop actually consumes — the
 * StatblockFeature.parsed stubs here are placeholders to satisfy the type
 * but never read from.
 */
export function actorIntentToReloadedStatblock(intent: ActorIntent): ReloadedStatblock {
  const { challenge, challengeNumeric } = challengeFields(intent.cr);

  return {
    name: intent.name,
    size: intent.size ?? 'Medium',
    type: intent.type ?? 'Humanoid',
    subtype: intent.subtype ?? null,
    alignment: intent.alignment ?? '',

    ac: intent.ac?.value ?? 10,
    acNote: intent.ac?.note ?? null,

    hp: {
      avg: intent.hp?.max ?? 1,
      formula: intent.hp?.formula ?? null,
    },

    speedText: '',
    speed: buildSpeedRecord(intent),

    abilities: buildAbilities(intent),

    // Saves: convert Partial<Record<AbilityKey, number>> to Record<string, number>.
    saves: intent.saves
      ? Object.fromEntries(
          Object.entries(intent.saves).filter(([, v]) => v !== undefined),
        ) as Record<string, number>
      : {},
    skills: intent.skills ?? {},

    damageResistances: joinOrNull(intent.damageResistances),
    damageImmunities: joinOrNull(intent.damageImmunities),
    damageVulnerabilities: joinOrNull(intent.damageVulnerabilities),
    conditionImmunities: joinConditionsOrNull(intent.conditionImmunities),

    sensesText: buildSensesText(intent),
    passivePerception: intent.senses?.passivePerception ?? null,

    languages: intent.languages?.join(', ') ?? '',

    challenge,
    challengeNumeric,

    proficiencyBonus: intent.proficiencyBonus ?? null,

    traits: (intent.traits ?? []).map(t => feature(t.name, t.description)),
    actions: (intent.actions ?? []).map(a => feature(a.name, a.description)),
    bonusActions: (intent.bonusActions ?? []).map(a => feature(a.name, a.description)),
    reactions: (intent.reactions ?? []).map(a => feature(a.name, a.description)),
    legendaryActions: (intent.legendaryActions ?? []).map(a => feature(a.name, a.description)),
    lairActions: (intent.lairActions ?? []).map(a => feature(a.name, a.description)),
  };
}
