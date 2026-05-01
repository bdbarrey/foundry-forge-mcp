// Phase 12.0 — Intent writers. Pure functions: ActionIntent → dnd5e item /
// activity / ActiveEffect docs. No Foundry deps, no async, no I/O.
//
// Three dispatch shapes match today's writer surface in create-actor.ts:
//
//   writeScratchItem(intent, opts)        — full feat item document. The
//     scratch-build path (no compendium base; novel Reloaded action).
//
//   writeActivityUpdate(itemId, base, intent) — flat dot-path update doc.
//     The copy-patch path (compendium base item already exists; we patch
//     activity fields keyed by the base's discovered activityIds).
//
//   writeTrait(intent, opts)              — full trait item document. The
//     trait-template path (Pack Tactics, Sunlight Sensitivity, or plain
//     description-only feat).
//
//   writeConditionEffect(condition, id)   — single ActiveEffect doc. Used
//     internally by writeScratchItem to materialize ActionIntent.conditions[]
//     entries, exported for Phase 11 audit comparisons.
//
// Output of writeScratchItem matches today's buildScratchActionItem(name,
// description, parsed) byte-shape — same field ordering, same shapes for
// system.activities[<id>], same effects[] structure, same flags. The 279
// existing mcp-server tests should pass unchanged when the parser side is
// adapted to emit ActionIntent + the writer takes over emitting the item doc.
//
// Why "byte-shape" matters: the audit framework (Phase 11) compares actor
// readback to writer output. Diverging field order or shape would surface
// as audit divergences across every Reloaded creature. We preserve shape on
// purpose, even when a "cleaner" alternative exists — until Phase 12.2
// flips the LLM source on, the writer stays a drop-in.

import type {
  ActionIntent,
  ActivityIntent,
  ConditionIntent,
  TraitIntent,
} from './activity-intent.js';

// ----- Shared id + payload helpers -----------------------------------------

/**
 * dnd5e activity / effect IDs are 16 alphanumeric chars (Foundry's standard
 * doc id length). Random — collisions across activities on one item are
 * vanishingly unlikely at 16 chars from a 62-char alphabet.
 */
export function genActivityId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export const genEffectId = genActivityId;

/**
 * dnd5e 4.x damage-part shape. Custom formula sidesteps the dice-denomination
 * bookkeeping ("1d8 + ability mod" → "1d8 + 4" pre-rolled). `types: [type]`
 * is the array-shape required by 5.x SaveActivity / AttackActivity damage.
 */
export function damagePartPayload(d: { formula: string; type: string }) {
  return {
    custom: { enabled: true, formula: d.formula },
    types: [d.type],
  };
}

/**
 * Foundry's bundled SVG icons for dnd5e condition statuses. Ships with core
 * Foundry under `icons/svg/` — renders even when the user hasn't installed
 * an icon-pack module. Keys mirror ConditionType from action-description.ts.
 */
export const CONDITION_ICONS: Record<string, string> = {
  blinded: 'icons/svg/blind.svg',
  charmed: 'icons/svg/heart.svg',
  deafened: 'icons/svg/sound.svg',
  frightened: 'icons/svg/terror.svg',
  grappled: 'icons/svg/net.svg',
  incapacitated: 'icons/svg/silenced.svg',
  paralyzed: 'icons/svg/paralysis.svg',
  petrified: 'icons/svg/statue.svg',
  poisoned: 'icons/svg/poison.svg',
  prone: 'icons/svg/falling.svg',
  restrained: 'icons/svg/net.svg',
  stunned: 'icons/svg/daze.svg',
  unconscious: 'icons/svg/unconscious.svg',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ----- writeConditionEffect -------------------------------------------------

/**
 * Build a Foundry ActiveEffect document from a ConditionIntent. Mirrors the
 * DDB-imported Wolf Bite "Status: Prone" effect shape: transfer:false (only
 * fires when the activity links it, not passively on item add), DAE
 * stackable=noneName (one instance per condition), Midi forceCEOff (use
 * Foundry native conditions, not Convenient Effects which can shadow
 * statuses).
 *
 * `effectId` is supplied by the caller so writeScratchItem can pre-allocate
 * IDs and link them from activities[].effects[]. When omitted, generates a
 * fresh id (useful for audit + tests).
 */
export function writeConditionEffect(
  condition: ConditionIntent,
  effectId?: string,
): Record<string, any> {
  const id = effectId ?? genEffectId();
  const titleCase = condition.type[0].toUpperCase() + condition.type.slice(1);
  const effect: Record<string, any> = {
    _id: id,
    name: titleCase,
    statuses: [condition.type],
    img: CONDITION_ICONS[condition.type] ?? 'icons/svg/aura.svg',
    type: 'base',
    system: {},
    changes: [],
    disabled: false,
    transfer: false,
    // Foundry's createEmbeddedDocuments silently strips effects[] arrays when
    // these scaffolding fields are missing. Mirror DDB-imported Wolf Bite:
    // origin null, sort 0, blank tint + description.
    origin: null,
    sort: 0,
    tint: '#ffffff',
    description: '',
    flags: {
      dae: {
        transfer: false,
        stackable: 'noneName',
        // specialDuration mirrors DAE's tag list; "turnEnd"/"turnStart"
        // tells Times-Up to expire at end/start of source's next turn.
        specialDuration: condition.duration?.specialDuration
          ? [condition.duration.specialDuration]
          : [],
        // showIcon=false suppresses the effect's own icon — statuses[]
        // already toggles the dnd5e condition icon. Without this, both
        // icons render → double icon on token (live-verified Volenta
        // 2026-04-29). Same flag the DDB Wolf Bite "Status: Prone" uses.
        showIcon: false,
      },
      'midi-qol': { forceCEOff: true },
      core: {},
    },
  };

  if (condition.duration && (condition.duration.rounds || condition.duration.seconds)) {
    effect.duration = {
      startTime: null,
      seconds: condition.duration.seconds ?? null,
      rounds: condition.duration.rounds ?? null,
      turns: null,
      startRound: null,
      startTurn: null,
      combat: null,
    };
  }

  // Repeat-save → Midi-QOL OverTime change. Effect is INDEFINITE; the save
  // IS the expiry. Per Midi-QOL README "Optional Rules → Over Time Effects".
  if (condition.repeatSave) {
    const turn = condition.repeatSave.period === 'turnStart' ? 'start' : 'end';
    const overTimeValue =
      `turn=${turn}, saveDC=${condition.repeatSave.dc}, ` +
      `saveAbility=${condition.repeatSave.ability}, saveRemove=true, ` +
      `label=${titleCase}`;
    effect.changes.push({
      key: 'flags.midi-qol.OverTime',
      mode: 0,
      value: overTimeValue,
      priority: 20,
    });
  }

  return effect;
}

// ----- writeActivityDoc (used by writeScratchItem) -------------------------

interface ActivityWriteCtx {
  /** Map intent.intentId → freshly-allocated dnd5e activity _id. */
  activityIdMap: Map<string, string>;
  /** Map condition index in ActionIntent.conditions[] → effect _id. */
  effectIdMap: Map<number, string>;
}

function writeActivityDoc(activity: ActivityIntent, ctx: ActivityWriteCtx): Record<string, any> {
  const _id = ctx.activityIdMap.get(activity.intentId)!;

  const doc: Record<string, any> = {
    type: activity.kind,
    _id,
    name: activity.name,
  };

  if (activity.kind === 'attack' && activity.attack) {
    doc.attack = {
      bonus: (activity.attack.bonus >= 0 ? '+' : '') + activity.attack.bonus,
      flat: true,
      ...(activity.attack.attackType
        ? { type: { value: activity.attack.attackType, classification: 'weapon' } }
        : {}),
      critical: {},
    };
  }

  if (activity.kind === 'save' && activity.save) {
    doc.save = {
      ability: [activity.save.ability],
      dc: { calculation: '', formula: String(activity.save.dc) },
    };
  }

  if (activity.damage && activity.damage.parts.length > 0) {
    const damage: Record<string, any> = {
      parts: activity.damage.parts.map(damagePartPayload),
    };
    if (activity.damage.includeBase === false) damage.includeBase = false;
    if (activity.kind === 'attack') damage.critical = {};
    if (activity.damage.onSave) damage.onSave = activity.damage.onSave;
    doc.damage = damage;
  }

  if (activity.range) {
    const range: Record<string, any> = { units: activity.range.units };
    if (activity.range.reach !== undefined) {
      range.reach = activity.range.reach;
      // Attack-side reach overrides the compendium-base item range; save-side
      // ranges don't write override (the save activity has no base range).
      if (activity.kind === 'attack') range.override = true;
    }
    if (activity.range.value !== undefined) {
      range.value = activity.range.value;
      if (activity.range.long !== undefined) range.long = activity.range.long;
      if (activity.kind === 'attack') range.override = true;
    }
    doc.range = range;
  }

  if (activity.target) {
    const target: Record<string, any> = { prompt: true };
    if (activity.target.template) {
      target.template = {
        type: activity.target.template.shape,
        size: activity.target.template.size,
        units: 'ft',
        ...(activity.target.template.width !== undefined
          ? { width: activity.target.template.width }
          : {}),
      };
    }
    if (activity.target.affects) {
      target.affects = {
        type: activity.target.affects.type,
        ...(activity.target.affects.count !== undefined
          ? { count: activity.target.affects.count }
          : {}),
        ...(activity.target.affects.choice !== undefined
          ? { choice: activity.target.affects.choice }
          : {}),
      };
    }
    doc.target = target;
  }

  if (activity.triggers) {
    const triggeredId = ctx.activityIdMap.get(activity.triggers.activityRef);
    if (triggeredId) {
      doc.midiProperties = {
        triggeredActivityId: triggeredId,
        triggeredActivityTargets: activity.triggers.targets,
      };
    }
  }

  if (activity.effects && activity.effects.length > 0) {
    doc.effects = activity.effects.map(link => {
      const effId = ctx.effectIdMap.get(link.conditionRef);
      return { _id: effId, level: { min: null, max: null }, onSave: link.onSave ?? false };
    });
  }

  return doc;
}

// ----- writeScratchItem -----------------------------------------------------

export interface WriteScratchItemOpts {
  /** Resolved icon URL (caller does icon resolution; writer is sync). */
  img: string;
  /** Override id generators for deterministic tests. */
  genItemId?: () => string;
  genActivityId?: () => string;
  genEffectId?: () => string;
}

/**
 * Build a full feat item document from an ActionIntent. Mirrors today's
 * buildScratchActionItem output — same field ordering, same shape for
 * system.activities[<id>] and effects[].
 */
export function writeScratchItem(
  intent: ActionIntent,
  opts: WriteScratchItemOpts,
): Record<string, any> {
  const allocItemId = opts.genItemId ?? genActivityId;
  const allocActivityId = opts.genActivityId ?? genActivityId;
  const allocEffectId = opts.genEffectId ?? genEffectId;

  // Pre-allocate ids so activities[].effects[].conditionRef and
  // attack.triggers.activityRef can resolve at write time.
  const activityIdMap = new Map<string, string>();
  for (const activity of intent.activities) {
    activityIdMap.set(activity.intentId, allocActivityId());
  }
  const effectIdMap = new Map<number, string>();
  intent.conditions.forEach((_c, i) => {
    effectIdMap.set(i, allocEffectId());
  });

  const ctx: ActivityWriteCtx = { activityIdMap, effectIdMap };

  const system: Record<string, any> = {
    description: { value: `<p>${escapeHtml(intent.description)}</p>` },
    source: { book: 'CoS Reloaded' },
    type: { value: 'monster' },
  };

  if (intent.usage) {
    const uses = buildUsesPayload(intent.usage);
    if (uses) system.uses = uses;
  }

  if (intent.activities.length > 0) {
    const activities: Record<string, any> = {};
    for (const activity of intent.activities) {
      const _id = activityIdMap.get(activity.intentId)!;
      activities[_id] = writeActivityDoc(activity, ctx);
    }
    system.activities = activities;
  }

  const itemEffects: Record<string, any>[] = intent.conditions.map((c, i) =>
    writeConditionEffect(c, effectIdMap.get(i)),
  );

  const itemFlags: Record<string, any> = {
    'foundry-forge-mcp': { source: 'reloaded-scratch-action' },
  };
  if (intent.midiProperties?.saveDamage) {
    itemFlags.midiProperties = { saveDamage: intent.midiProperties.saveDamage };
  }

  return {
    _id: allocItemId(),
    name: intent.name,
    type: 'feat',
    img: opts.img,
    system,
    ...(itemEffects.length > 0 ? { effects: itemEffects } : {}),
    flags: itemFlags,
  };
}

// ----- writeActivityUpdate (copy-patch path) -------------------------------

/**
 * Build a flat dot-path update doc that patches the named activities of an
 * existing compendium-based item. Caller passes the discovered activityId
 * map (from the base item) — we don't allocate new IDs here.
 *
 * Mirrors today's buildItemActivityUpdate(itemId, activities, parsed).
 *
 * `activities` is the BASE ITEM's activity map ({activityId → activity doc}).
 * The intent's activities[] are mapped to the base by KIND:
 *   - the first 'attack' kind in intent matches the first 'attack' base
 *   - the first 'save' kind in intent matches the first 'save' base
 *   - 'damage' base activities get the intent's primary damage when there's
 *     no save in intent (matches today's behavior)
 *
 * Damage routing rule (must match today):
 *   damage rides attack when intent has any 'attack' activity, otherwise
 *   damage rides the save (or damage) activity.
 */
export function writeActivityUpdate(
  itemId: string,
  baseActivities: Record<string, any>,
  intent: ActionIntent,
): Record<string, any> {
  const u: Record<string, any> = { _id: itemId };

  const attackIntent = intent.activities.find(a => a.kind === 'attack');
  const saveIntent = intent.activities.find(a => a.kind === 'save');
  const primaryDamage = attackIntent?.damage ?? saveIntent?.damage ?? findDamage(intent);

  const damageGoesOnAttack = !!attackIntent;
  const damageGoesOnSave = !damageGoesOnAttack && !!saveIntent;

  for (const [activityId, activity] of Object.entries(baseActivities)) {
    const base = `system.activities.${activityId}`;
    const type = activity?.type;

    if (type === 'attack' && attackIntent?.attack) {
      u[`${base}.attack.bonus`] =
        (attackIntent.attack.bonus >= 0 ? '+' : '') + attackIntent.attack.bonus;
      u[`${base}.attack.flat`] = true;
      if (attackIntent.attack.attackType) {
        u[`${base}.attack.type.value`] = attackIntent.attack.attackType;
      }

      if (damageGoesOnAttack && primaryDamage && primaryDamage.parts.length > 0) {
        u[`${base}.damage.parts`] = primaryDamage.parts.map(damagePartPayload);
        // Reloaded prints full damage formula → suppress base contribution
        // so 2d4+4 doesn't double to 4d4+8 with the weapon's base die.
        u[`${base}.damage.includeBase`] = false;
      }

      const attackRange = attackIntent.range;
      if (attackRange?.reach !== undefined) {
        u[`${base}.range.reach`] = attackRange.reach;
        u[`${base}.range.units`] = 'ft';
        u[`${base}.range.override`] = true;
      }
      if (attackRange?.value !== undefined) {
        u[`${base}.range.value`] = attackRange.value;
        if (attackRange.long !== undefined) u[`${base}.range.long`] = attackRange.long;
        u[`${base}.range.units`] = 'ft';
        u[`${base}.range.override`] = true;
      }
    }

    if (type === 'save' && saveIntent?.save) {
      u[`${base}.save`] = {
        ability: [saveIntent.save.ability],
        dc: { calculation: '', formula: String(saveIntent.save.dc) },
      };

      if (damageGoesOnSave && primaryDamage && primaryDamage.parts.length > 0) {
        u[`${base}.damage.parts`] = primaryDamage.parts.map(damagePartPayload);
        if (saveIntent.save.onSuccess === 'half') {
          u[`${base}.damage.onSave`] = 'half';
        }
        const saveRange = saveIntent.range;
        if (saveRange?.value !== undefined) {
          u[`${base}.range.value`] = saveRange.value;
          if (saveRange.long !== undefined) u[`${base}.range.long`] = saveRange.long;
          u[`${base}.range.units`] = 'ft';
          u[`${base}.range.override`] = true;
        }
      }
    }

    if (type === 'damage' && primaryDamage && primaryDamage.parts.length > 0) {
      u[`${base}.damage.parts`] = primaryDamage.parts.map(damagePartPayload);
    }

    // Phase 10A.7b targeting on copy-patched activities. Per-type — base item
    // dictates which activities exist; we patch what's there.
    const target = pickTargetForActivityType(type, attackIntent, saveIntent);
    if (target) {
      if (target.template) {
        u[`${base}.target.template.type`] = target.template.shape;
        u[`${base}.target.template.size`] = target.template.size;
        u[`${base}.target.template.units`] = 'ft';
        if (target.template.width !== undefined) {
          u[`${base}.target.template.width`] = target.template.width;
        }
      }
      if (target.affects) {
        u[`${base}.target.affects.type`] = target.affects.type;
        if (target.affects.count !== undefined) {
          u[`${base}.target.affects.count`] = target.affects.count;
        }
        if (target.affects.choice !== undefined) {
          u[`${base}.target.affects.choice`] = target.affects.choice;
        }
      }
      u[`${base}.target.prompt`] = true;
    }
  }

  // Item-level versatile alt-damage block.
  if (intent.versatile) {
    u['system.damage.versatile.custom.enabled'] = true;
    u['system.damage.versatile.custom.formula'] = intent.versatile.formula;
    u['system.damage.versatile.types'] = [intent.versatile.type];
    u['system.damage.versatile.bonus'] = '';
  }

  return u;
}

function findDamage(intent: ActionIntent) {
  for (const a of intent.activities) {
    if (a.damage && a.damage.parts.length > 0) return a.damage;
  }
  return undefined;
}

function pickTargetForActivityType(
  type: unknown,
  attackIntent: ActivityIntent | undefined,
  saveIntent: ActivityIntent | undefined,
) {
  const writeTargetOnAttack = type === 'attack' && !!attackIntent;
  const writeTargetOnSave = type === 'save' && !!saveIntent && !attackIntent;
  const writeTargetOnDamage = type === 'damage' && (!!attackIntent || !!saveIntent);
  if (writeTargetOnAttack) return attackIntent?.target;
  if (writeTargetOnSave) return saveIntent?.target;
  if (writeTargetOnDamage) return (attackIntent ?? saveIntent)?.target;
  return undefined;
}

// ----- writeTrait (Phase 10B trait-template path) --------------------------

export interface WriteTraitOpts {
  /** Override id generator for deterministic tests. */
  genEffectId?: () => string;
}

/**
 * Build trait item additions from a TraitIntent. Returns the partial
 * `{ effects: [<ActiveEffect>] }` block that today's TRAIT_TEMPLATES.build()
 * returns — caller merges this on top of the default {description, source,
 * type:monster, img} item shell. The trait ITEM's icon is resolved by the
 * caller (resolveFeatIcon); writeTrait only owns the rider effect shape.
 */
export function writeTrait(
  intent: TraitIntent,
  opts?: WriteTraitOpts,
): Record<string, any> {
  const allocEffectId = opts?.genEffectId ?? genEffectId;

  if (intent.kind === 'pack-tactics') {
    return {
      effects: [{
        _id: allocEffectId(),
        name: 'Pack Tactics',
        statuses: [],
        transfer: true,
        disabled: false,
        img: 'icons/environment/wilderness/statue-hound-horned.webp',
        type: 'base',
        system: {},
        origin: null,
        sort: 0,
        tint: '#ffffff',
        description: '',
        // Midi custom-mode (mode=0) — Pack Tactics fires when ≥ 2 tokens
        // hostile-to-target are within 5ft of the target (attacker plus
        // ≥ 1 ally). DDB-importer omits the `key` field, which makes
        // Pack Tactics fire indiscriminately ("always advantage"). Required.
        changes: [{
          key: 'flags.midi-qol.advantage.attack.all',
          value: 'findNearby(-1, targetUuid, 5, 0).length > 1',
          mode: 0,
          priority: 20,
        }],
        flags: {
          dae: { transfer: true, stackable: 'noneName', specialDuration: [] },
          'midi-qol': { forceCEOff: true },
          core: {},
        },
      }],
    };
  }

  if (intent.kind === 'sunlight-sensitivity') {
    return {
      effects: [{
        _id: allocEffectId(),
        name: 'Sunlight Sensitivity',
        statuses: [],
        transfer: true,
        // Disabled by default — Foundry has no "is in sunlight" check; GM
        // toggles the effect on/off when the creature enters/exits sunlight.
        disabled: true,
        img: 'icons/magic/light/explosion-star-glow-yellow.webp',
        type: 'base',
        system: {},
        origin: null,
        sort: 0,
        tint: '#ffffff',
        description: 'Disabled by default — GM enables when the creature is in sunlight',
        changes: [
          { key: 'flags.midi-qol.disadvantage.attack.all', value: '1', mode: 0, priority: 20 },
          { key: 'flags.midi-qol.disadvantage.ability.check.all', value: '1', mode: 0, priority: 20 },
        ],
        flags: {
          dae: { transfer: true, stackable: 'noneName', specialDuration: [] },
          'midi-qol': { forceCEOff: true },
          core: {},
        },
      }],
    };
  }

  // description-only — no effect, caller falls back to default feat shell.
  return {};
}

// ----- buildUsesPayload (item-level system.uses) ---------------------------

function buildUsesPayload(usage: ActionIntent['usage']): Record<string, any> | undefined {
  if (!usage) return undefined;
  if ('recharge' in usage) {
    const [min, max] = usage.recharge;
    return {
      max: '1',
      spent: 0,
      recovery: [{ period: 'recharge', type: 'recoverAll', formula: `${min}-${max}` }],
    };
  }
  if ('count' in usage && 'period' in usage) {
    const period =
      usage.period === 'day' ? 'day' :
      usage.period === 'long-rest' ? 'lr' :
      usage.period === 'short-rest' ? 'sr' :
      'turn';
    return {
      max: String(usage.count),
      spent: 0,
      recovery: [{ period, type: 'recoverAll', formula: '' }],
    };
  }
  return undefined;
}
