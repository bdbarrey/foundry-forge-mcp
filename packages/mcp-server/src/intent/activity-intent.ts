// Phase 12.0 — ActionIntent schema. The contract between the build pipeline's
// "what should this action do" layer (today: regex parser; tomorrow: LLM via
// option 3) and the writer that emits dnd5e activity / item / ActiveEffect
// docs. Pure types; no runtime, no Foundry deps.
//
// Why this layer exists: the regex parser in parsers/action-description.ts
// extends per Reloaded prose variant and doesn't scale. Phase 12 swaps the
// parser for an LLM call that emits ActionIntent JSON; the writer is unchanged.
// Phase 12.0 introduces the schema + writer, with parsed-to-intent.ts adapting
// today's parser output until 12.1 flips to the LLM source.
//
// The single-action shape is ActionIntent — one Reloaded action description
// → one ActionIntent → one item document. ActionIntent contains 1-2
// activities (attack, save, or both chained Bite-style), 0-N rider
// conditions referenced by save activities, and item-level fields (uses,
// versatile, midi flags).

import type {
  AbilityKey,
  AttackType,
  ConditionType,
  DamagePart,
  ParsedConditionDuration,
  ParsedRepeatSave,
  TemplateShape,
} from '../parsers/action-description.js';

export type { AbilityKey, AttackType, ConditionType, DamagePart, TemplateShape };

export type ActivityKind = 'attack' | 'save' | 'damage';

/**
 * Range / reach on an activity. Mutually-exclusive shapes:
 *   - Attack with melee reach: { reach: 5, units: 'ft' }
 *   - Attack/save with throw range: { value: 30, long?: 60, units: 'ft' }
 * The writer emits dnd5e activity.range with `override: true` so the value
 * sticks even when the compendium base item has its own range.
 */
export interface RangeIntent {
  value?: number;
  long?: number;
  reach?: number;
  units: 'ft';
}

/** Area template — radius/cone/line/cube/sphere/cylinder. */
export interface TemplateIntent {
  shape: TemplateShape;
  /** Size in feet — radius for circle/sphere, length for cone/line/cube edge. */
  size: number;
  /** Optional width in feet (lines only; dnd5e default 5). */
  width?: number;
}

/**
 * Affects spec — who inside the area is affected.
 * `count` + `choice` carry meaning even when a template is present:
 *   "up to two creatures within 10 feet of one another, of your choice" =>
 *   template:{circle,10} + affects:{type:creature, count:2, choice:true}.
 */
export interface AffectsIntent {
  type: 'creature' | 'enemy' | 'ally' | 'object' | 'self' | 'space';
  count?: number;
  choice?: boolean;
}

export interface TargetIntent {
  template?: TemplateIntent;
  affects?: AffectsIntent;
}

export interface AttackIntent {
  /** Numeric attack bonus, e.g. +7 → 7. Writer signs the string. */
  bonus: number;
  attackType?: AttackType;
}

export interface SaveIntent {
  ability: AbilityKey;
  dc: number;
  onSuccess?: 'half';
}

export interface DamageIntent {
  parts: DamagePart[];
  /**
   * Whether to add the compendium-base weapon die on top of `parts`. Default
   * dnd5e is true (base + override). Reloaded prints the FULL formula so
   * we set false for both scratch-build and copy-patch — without false the
   * activity rolls 4d4+8 instead of Reloaded's 2d4+4.
   */
  includeBase?: boolean;
  /**
   * Save-failure damage behavior. Only meaningful when the parent activity
   * is a save. 'half' = half on save, 'none' = no damage on save.
   */
  onSave?: 'half' | 'none' | 'full';
}

/**
 * Reference from an activity to a rider condition. `conditionRef` is the
 * index into ActionIntent.conditions[]; the writer resolves it to a real
 * ActiveEffect _id at write time.
 *
 * `onSave: false` (the default) means "apply on save FAIL" — matches dnd5e's
 * effects[].onSave semantics. true = apply on save success (rare).
 */
export interface ActivityEffectLink {
  conditionRef: number;
  onSave?: boolean;
}

/**
 * One activity within an ActionIntent. Attack-with-save (Bite + prone)
 * produces TWO ActivityIntents on one ActionIntent — the attack's `triggers`
 * field references the save's intentId so the writer wires up Midi-QOL's
 * triggeredActivityId chain.
 */
export interface ActivityIntent {
  /** Stable id within the parent ActionIntent (used by triggers + tests). */
  intentId: string;
  kind: ActivityKind;
  /** Display name on the activity ("Attack", "Save", "Midi Save"). */
  name: string;
  range?: RangeIntent;
  target?: TargetIntent;
  attack?: AttackIntent;
  save?: SaveIntent;
  damage?: DamageIntent;
  /** Chain another activity to fire after this one resolves. */
  triggers?: { activityRef: string; targets: 'hit' | 'all' };
  /** Effects to apply when this activity resolves (typically save activities). */
  effects?: ActivityEffectLink[];
}

/**
 * Rider condition referenced by activities[].effects[]. Mirrors today's
 * ParsedCondition shape; arrays of ConditionIntent on ActionIntent close the
 * Phase 10C multi-condition gap (Thunderstone: prone + deafened on one save).
 */
export interface ConditionIntent {
  type: ConditionType;
  duration?: ParsedConditionDuration;
  repeatSave?: ParsedRepeatSave;
}

/**
 * Item-level uses payload — recharge counter on the sheet. Mirrors the
 * ParsedAction['usage'] union: per-day count, per-rest count, or recharge
 * range.
 */
export type UsageIntent =
  | { count: number; period: 'day' | 'long-rest' | 'short-rest' | 'turn' }
  | { recharge: [number, number] };

/** Item-level versatile alt-damage (Longsword two-hand). */
export interface VersatileIntent {
  formula: string;
  type: string;
}

/** Item-level Midi flag block. */
export interface ActionMidiProperties {
  /**
   * Save-or-half items need this flag on the ITEM (not the activity) so
   * Midi's GUI for the save shows the correct "half on save" default
   * even when activity.damage.onSave is already 'half'.
   */
  saveDamage?: 'halfdam' | 'fulldam' | 'nodam';
}

/**
 * One Reloaded action description → one ActionIntent → one feat item. The
 * writer takes ActionIntent and emits either:
 *   - a full feat item document (scratch-build path), or
 *   - a flat dot-path update doc (copy-patch path on a compendium item).
 */
export interface ActionIntent {
  /** Bare action name with usage suffix already stripped ("Tanglefoot"). */
  name: string;
  /** Original prose for system.description.value. */
  description: string;
  /** Item-level uses payload — recharge counter. */
  usage?: UsageIntent;
  /** Item-level versatile alt-damage block. */
  versatile?: VersatileIntent;
  /** Item-level Midi flags. */
  midiProperties?: ActionMidiProperties;
  /** Activities on the item, ordered (attack first when chained). */
  activities: ActivityIntent[];
  /** Rider conditions referenced by activities[].effects[].conditionRef. */
  conditions: ConditionIntent[];
}

/**
 * Trait template kinds.
 * - `description-only` — plain feat, no ActiveEffect (Innate Spellcasting label,
 *   most narrative traits like "Awakened Bloodlust" without mechanical effect).
 * - `pack-tactics` / `sunlight-sensitivity` — TRAIT_TEMPLATES registry entries
 *   with canonical Midi/DAE shapes maintained in the writer (drift-resistant).
 * - `custom` — orchestrating Claude session supplies the ActiveEffect shape
 *   directly via TraitIntent.custom for traits the registry doesn't cover
 *   (Magic Resistance, Regeneration, Spider Climb-with-effect, etc.).
 */
export type TraitIntentKind =
  | 'pack-tactics'
  | 'sunlight-sensitivity'
  | 'description-only'
  | 'custom';

/**
 * Custom rider effect spec — used when TraitIntent.kind === 'custom'. Lets
 * the orchestrating Claude session emit arbitrary Midi-QOL / DAE / dnd5e
 * ActiveEffect changes for traits not in the registry.
 *
 * Caller fills only the fields that diverge from defaults. Defaults applied
 * by the writer:
 *   statuses: []                         // no Foundry condition coupling
 *   transfer: true                       // always-on (typical for traits)
 *   disabled: false                      // active by default
 *   sort: 0, tint: '#ffffff', system: {}, origin: null, description: ''
 *   flags.dae.{ transfer, stackable: 'noneName', specialDuration: [] }
 *   flags['midi-qol'].forceCEOff: true
 *
 * `transfer: false` is rare for trait effects (effect-only-while-feature-is-
 * activated), but supported for traits like Sunlight Sensitivity that toggle
 * via GM action.
 */
export interface CustomTraitEffect {
  /** ActiveEffect.name. Defaults to the parent TraitIntent.name. */
  effectName?: string;
  /** Effect icon path. Defaults to a generic aura icon. */
  img?: string;
  /** Foundry condition statuses[] this effect toggles when active. */
  statuses?: string[];
  /** true = transfer to actor on item add (always-on); false = activity-only. */
  transfer?: boolean;
  /** Start disabled (GM toggles on/off — Sunlight Sensitivity pattern). */
  disabled?: boolean;
  /** ActiveEffect changes[] — the actual mechanic. */
  changes?: Array<{
    key: string;
    value: string;
    /** ActiveEffect mode. Default 0 (CUSTOM) — Midi evaluates value as JS. */
    mode?: number;
    /** Default 20 (above ABILITY_NODE_DEFAULT_PRIORITY 10). */
    priority?: number;
  }>;
  /** Time-bounded effects (rare for traits). */
  duration?: { rounds?: number; seconds?: number };
  /** Override the writer's default DAE / Midi-QOL flag block. */
  flags?: {
    dae?: {
      transfer?: boolean;
      stackable?: string;
      specialDuration?: string[];
      showIcon?: boolean;
    };
    'midi-qol'?: { forceCEOff?: boolean };
  };
}

export interface TraitIntent {
  kind: TraitIntentKind;
  name: string;
  description: string;
  /** Required when kind === 'custom'; ignored otherwise. */
  custom?: CustomTraitEffect;
}
