// Phase 12.0 — adapter from today's regex-parser output (ParsedAction) to
// ActionIntent. Until Phase 12.1 swaps the LLM in as the intent source, this
// adapter is the only producer of ActionIntent in the build pipeline.
//
// Pure function. The caller is expected to have already:
//   - stripped the usage suffix off the action name (Reloaded encodes
//     "(1/Day)" / "(Recharge 5-6)" in the action NAME; strip happens in
//     create-actor.ts before this is called)
//   - resolved usage = name-marker ?? parsed.usage (matches today's
//     buildScratchActionItem behavior — name-side marker wins when both
//     exist, since Reloaded names are the primary source)
//
// Routing rules (must match today's writer for byte-shape compatibility):
//   - save activity emitted when parsed.save
//   - attack activity emitted when parsed.attackBonus !== undefined
//   - both → chained (attack triggers save with targets='hit')
//   - damage routing: rides attack when attackBonus is set, otherwise rides
//     save (the discriminator is parsed shape, not base item shape)
//   - target shape: on the activity that carries the action (attack when
//     present; save otherwise)
//   - condition (parsed produces 0 or 1) → conditions[] entry, linked from
//     the save activity's effects[]
//   - midiProperties.saveDamage='halfdam' on the ITEM when the save grants
//     half-on-success AND there's primary damage

import type {
  ParsedAction,
  ParsedTargetShape,
} from '../parsers/action-description.js';
import type {
  ActionIntent,
  ActivityIntent,
  AttackIntent,
  ConditionIntent,
  RangeIntent,
  SaveIntent,
  TargetIntent,
  UsageIntent,
} from './activity-intent.js';

export interface ParsedToIntentInput {
  /** Action name, already stripped of any usage suffix. */
  name: string;
  /** Original Reloaded prose for system.description.value. */
  description: string;
  /**
   * Pre-resolved usage payload. Caller picks marker (from name strip) over
   * parsed.usage (from description) — matching today's behavior where the
   * Reloaded name is primary. `undefined` is permitted alongside absence
   * since callers compute this with `??` and may pass through `undefined`.
   */
  usage?: ParsedAction['usage'] | undefined;
  /** The parsed shape — null/undefined produces a description-only intent. */
  parsed?: ParsedAction | null | undefined;
}

export function parsedActionToIntent(input: ParsedToIntentInput): ActionIntent {
  const { name, description, usage, parsed } = input;

  const intent: ActionIntent = {
    name,
    description,
    activities: [],
    conditions: [],
  };

  if (usage) intent.usage = usage as UsageIntent;

  if (parsed?.versatile) {
    intent.versatile = { formula: parsed.versatile.formula, type: parsed.versatile.type };
  }

  // Conditions array: today's parser emits 0 or 1 condition. Phase 12.1+
  // (LLM source) can emit multiple — the schema is ready for it.
  if (parsed?.condition) {
    const c: ConditionIntent = { type: parsed.condition.type };
    if (parsed.condition.duration) c.duration = parsed.condition.duration;
    if (parsed.condition.repeatSave) c.repeatSave = parsed.condition.repeatSave;
    intent.conditions.push(c);
  }

  if (!parsed) {
    return intent;
  }

  const hasSave = !!parsed.save;
  const hasAttack = parsed.attackBonus !== undefined;

  // Save activity. Emitted before attack so chained-Bite items have save
  // first in the activities[] array — preserves today's insertion order
  // into system.activities (set by buildScratchActionItem).
  if (hasSave && parsed.save) {
    const damageGoesOnSave = parsed.damage.length > 0 && !hasAttack;

    const saveIntent: ActivityIntent = {
      intentId: 'save',
      kind: 'save',
      name: 'Save',
    };

    const save: SaveIntent = { ability: parsed.save.ability, dc: parsed.save.dc };
    if (parsed.save.onSuccess) save.onSuccess = parsed.save.onSuccess;
    saveIntent.save = save;

    if (damageGoesOnSave) {
      saveIntent.damage = {
        parts: parsed.damage,
        onSave: parsed.save.onSuccess === 'half' ? 'half' : 'none',
      };
    }

    if (parsed.range) {
      const range: RangeIntent = { value: parsed.range.normal, units: 'ft' };
      if (parsed.range.long !== undefined) range.long = parsed.range.long;
      saveIntent.range = range;
    }

    // Target lives on save activity ONLY when there's no attack — when
    // both exist the targeting belongs to the attack (you target the bite,
    // the save resolves against the hit target).
    if (!hasAttack) {
      const target = buildTargetIntent(parsed.targetShape);
      if (target) saveIntent.target = target;
    }

    if (parsed.condition) {
      saveIntent.effects = [{ conditionRef: 0, onSave: false }];
    }

    intent.activities.push(saveIntent);
  }

  // Attack activity.
  if (hasAttack) {
    const attackIntent: ActivityIntent = {
      intentId: 'attack',
      kind: 'attack',
      name: hasSave ? 'Attack' : 'Midi Attack',
    };

    const attack: AttackIntent = { bonus: parsed.attackBonus! };
    if (parsed.attackType) attack.attackType = parsed.attackType;
    attackIntent.attack = attack;

    if (parsed.damage.length > 0) {
      attackIntent.damage = { parts: parsed.damage, includeBase: false };
    }

    if (parsed.reach !== undefined) {
      attackIntent.range = { reach: parsed.reach, units: 'ft' };
    } else if (parsed.range) {
      const range: RangeIntent = { value: parsed.range.normal, units: 'ft' };
      if (parsed.range.long !== undefined) range.long = parsed.range.long;
      attackIntent.range = range;
    }

    const target = buildTargetIntent(parsed.targetShape);
    if (target) attackIntent.target = target;

    // Chain attack → save when both exist. Midi-QOL fires the save against
    // the targets the attack actually hit.
    if (hasSave) {
      attackIntent.triggers = { activityRef: 'save', targets: 'hit' };
    }

    intent.activities.push(attackIntent);
  }

  // Item-level Midi flag for save-or-half items. CPR's pattern carries
  // saveDamage='halfdam' on the ITEM so Midi's GUI defaults right even
  // when activity.damage.onSave is already 'half'.
  if (parsed.save?.onSuccess === 'half' && parsed.damage.length > 0) {
    intent.midiProperties = { saveDamage: 'halfdam' };
  }

  return intent;
}

function buildTargetIntent(shape?: ParsedTargetShape): TargetIntent | undefined {
  if (!shape || (!shape.template && !shape.affects)) return undefined;
  const target: TargetIntent = {};
  if (shape.template) {
    target.template = {
      shape: shape.template.shape,
      size: shape.template.size,
      ...(shape.template.width !== undefined ? { width: shape.template.width } : {}),
    };
  }
  if (shape.affects) {
    target.affects = {
      type: shape.affects.type,
      ...(shape.affects.count !== undefined ? { count: shape.affects.count } : {}),
      ...(shape.affects.choice !== undefined ? { choice: shape.affects.choice } : {}),
    };
  }
  return target;
}
