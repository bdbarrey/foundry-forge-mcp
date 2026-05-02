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
  CustomTraitEffect,
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
 * Canonical condition icons that match the dnd5e system's own
 * CONFIG.statusEffects icons (systems/dnd5e/icons/svg/statuses/<name>.svg).
 *
 * In dnd5e 5.x, applying an AE with `statuses: [<condition>]` causes the
 * system to render its OWN canonical condition icon on the token AND the
 * AE's `img` icon as a separate icon — two icons stacked. (DAE's
 * `flags.dae.showIcon: false` flag from Phase 10C.1 is ignored in 5.x
 * because DAE isn't doing the rendering anymore.)
 *
 * Setting our AE's `img` to the same path the system uses means both
 * renders draw the same SVG, so they visually merge into one icon. (Live-
 * verified Volenta 2026-05-02 — Tanglefoot's restrained showed `icons/svg/net.svg`
 * stacked next to dnd5e's `systems/dnd5e/icons/svg/statuses/restrained.svg`.)
 */
export const CONDITION_ICONS: Record<string, string> = {
  blinded: 'systems/dnd5e/icons/svg/statuses/blinded.svg',
  charmed: 'systems/dnd5e/icons/svg/statuses/charmed.svg',
  deafened: 'systems/dnd5e/icons/svg/statuses/deafened.svg',
  frightened: 'systems/dnd5e/icons/svg/statuses/frightened.svg',
  grappled: 'systems/dnd5e/icons/svg/statuses/grappled.svg',
  incapacitated: 'systems/dnd5e/icons/svg/statuses/incapacitated.svg',
  paralyzed: 'systems/dnd5e/icons/svg/statuses/paralyzed.svg',
  petrified: 'systems/dnd5e/icons/svg/statuses/petrified.svg',
  poisoned: 'systems/dnd5e/icons/svg/statuses/poisoned.svg',
  prone: 'systems/dnd5e/icons/svg/statuses/prone.svg',
  restrained: 'systems/dnd5e/icons/svg/statuses/restrained.svg',
  stunned: 'systems/dnd5e/icons/svg/statuses/stunned.svg',
  unconscious: 'systems/dnd5e/icons/svg/statuses/unconscious.svg',
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
 * Build a Foundry ActiveEffect document from a ConditionIntent.
 *
 * dnd5e 5.x architecture (live-verified on Volenta 2026-05-02, dnd5e 5.3.2
 * + Midi-QOL 13.0.61):
 *
 * - `statuses[<type>]` on the AE: dnd5e 5.x auto-applies the canonical
 *   condition (puts the type in actor.statuses, fires the system's
 *   condition-mechanic hooks, the Conditions panel on the sheet shows it,
 *   chat actions like "you have the X condition" trigger correctly).
 *
 * - The token icon HUD renders BOTH actor.effects (AE.img per AE) AND
 *   actor.statuses (canonical CONFIG.statusEffects[type].icon). With our
 *   AE carrying statuses[], that means TWO icons render on the token.
 *
 * Naming convention (live-verified Volenta 2026-05-02 — user feedback):
 *   - AE name = source action name (e.g. "Tanglefoot"), passed via
 *     `sourceName` arg. The AE represents the SOURCE — that's exactly
 *     what the Temporary Effects panel is meant to track ("Restrained
 *     from Volenta's Tanglefoot", not just "Restrained").
 *   - AE img = source action img (the feat's icon), passed via
 *     `sourceImg`. Distinct from CONFIG.statusEffects[type].icon, so
 *     the two icons on the token convey distinct information:
 *       * Source-action icon = "this source effect is active and the
 *         save-loop is running"
 *       * Canonical condition icon = "target IS in the X state"
 *   - statuses[type] still set, so the canonical condition mechanics
 *     (rules engine integration + Conditions panel toggle) still fire.
 *
 * If sourceName/sourceImg are omitted (e.g. legacy buildConditionEffect
 * call from the regex parser path), falls back to condition title-case
 * name + canonical condition icon. Backward-compatible.
 *
 * `effectId` is supplied by the caller so writeScratchItem can pre-allocate
 * IDs and link them from activities[].effects[]. When omitted, generates a
 * fresh id (useful for audit + tests).
 */
export function writeConditionEffect(
  condition: ConditionIntent,
  effectId?: string,
  sourceName?: string,
  sourceImg?: string,
): Record<string, any> {
  const id = effectId ?? genEffectId();
  const titleCase = condition.type[0].toUpperCase() + condition.type.slice(1);
  const effect: Record<string, any> = {
    _id: id,
    name: sourceName ?? titleCase,
    statuses: [condition.type],
    img: sourceImg ?? CONDITION_ICONS[condition.type] ?? 'icons/svg/aura.svg',
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

  // dnd5e 5.x reference enrichers — Midi-QOL 13.x reads &Reference[<status>]
  // pills from the chat card and auto-applies the matching condition status
  // on the target on save fail (default config). The pill is also clickable
  // by the GM for setups where auto-apply is off. Adding these makes the
  // condition status icon render exactly once (canonical) instead of doubling
  // up against an AE-with-statuses[]. Names lower-cased to match
  // CONFIG.statusEffects ids.
  const referencePills = intent.conditions
    .map(c => `&Reference[${c.type}]`)
    .join(' ');
  const descriptionWithReferences = referencePills
    ? `<p>${escapeHtml(intent.description)}</p><p>${referencePills}</p>`
    : `<p>${escapeHtml(intent.description)}</p>`;

  const system: Record<string, any> = {
    description: { value: descriptionWithReferences },
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

  // Pass the source action's name + img so the AE represents the SOURCE
  // (e.g. "Tanglefoot") rather than the canonical condition ("Restrained").
  // The Temporary Effects panel is for tracking sources; canonical condition
  // state lives in actor.statuses (and renders separately on the token).
  // 2026-05-02 user-feedback finalize.
  const itemEffects: Record<string, any>[] = intent.conditions.map((c, i) =>
    writeConditionEffect(c, effectIdMap.get(i), intent.name, opts.img),
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

  if (intent.kind === 'sunlight-hypersensitivity') {
    // Sunlight Hypersensitivity = Sensitivity (disadvantage on attacks +
    // ability checks) + 20 radiant damage at start of turn. Vampires only —
    // distinct from orc-style Sunlight Sensitivity which has no damage tick.
    // GM toggles disabled→enabled when the creature enters sunlight.
    const damageAmount = parseLeadingInt(intent.description, /(\d+)\s+radiant\s+damage/i, 20);
    return {
      effects: [{
        _id: allocEffectId(),
        name: 'Sunlight Hypersensitivity',
        statuses: [],
        transfer: true,
        disabled: true,
        img: 'icons/magic/light/explosion-star-glow-yellow.webp',
        type: 'base',
        system: {},
        origin: null,
        sort: 0,
        tint: '#ffffff',
        description: 'Disabled by default — GM enables when the creature is in sunlight',
        changes: [
          { key: 'flags.midi-qol.OverTime.sunlightHypersensitivity', value: `turn=start,damageRoll=${damageAmount},damageType=radiant,label=Sunlight Hypersensitivity`, mode: 0, priority: 20 },
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

  if (intent.kind === 'regeneration') {
    // Parse the per-turn heal amount from the description ("regains X hit
    // points"). Defaults to 10 (standard vampire spawn / vampiric brides).
    // The condition expression suppresses the heal at full HP so chat doesn't
    // spam +0 heal rolls. Suppression on radiant/holy damage is GM-managed
    // (toggle the effect off for a turn) — too complex to automate.
    const healAmount = parseLeadingInt(intent.description, /regains?\s+(\d+)\s+hit\s+points?/i, 10);
    return {
      effects: [{
        _id: allocEffectId(),
        name: 'Regeneration',
        statuses: [],
        transfer: true,
        disabled: false,
        img: 'icons/magic/life/cross-area-circle-green-white.webp',
        type: 'base',
        system: {},
        origin: null,
        sort: 0,
        tint: '#ffffff',
        description: 'Auto-heals at start of turn; condition skips when at max HP',
        changes: [{
          key: 'flags.midi-qol.OverTime.regeneration',
          value: `turn=start,damageRoll=${healAmount},damageType=healing,label=Regeneration,condition=@attributes.hp.value<@attributes.hp.max`,
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

  if (intent.kind === 'magic-resistance') {
    // Advantage on saves against spells and magical effects. Standard Midi
    // shape uses flags.midi-qol.magicResistance.all — applied passively, no
    // GM toggle required.
    return {
      effects: [{
        _id: allocEffectId(),
        name: 'Magic Resistance',
        statuses: [],
        transfer: true,
        disabled: false,
        img: 'icons/magic/defensive/shield-barrier-glowing-blue.webp',
        type: 'base',
        system: {},
        origin: null,
        sort: 0,
        tint: '#ffffff',
        description: '',
        changes: [{
          key: 'flags.midi-qol.magicResistance.all',
          value: '1',
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

  if (intent.kind === 'custom') {
    if (!intent.custom) return {};
    return writeCustomTraitEffect(intent.custom, intent.name, allocEffectId);
  }

  // description-only — no effect, caller falls back to default feat shell.
  return {};
}

/**
 * Extract the first integer matched by `pattern` from `text`. Returns
 * `defaultValue` when the pattern doesn't match or the captured group
 * isn't parseable. Used by trait templates that scale with the printed
 * value (Regeneration heal amount, Sunlight Hypersensitivity damage tick).
 */
function parseLeadingInt(text: string, pattern: RegExp, defaultValue: number): number {
  const m = text.match(pattern);
  if (!m || !m[1]) return defaultValue;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * Phase 12.1.1 — emit an ActiveEffect doc from a CustomTraitEffect spec.
 * Called by writeTrait for kind='custom'. Applies the writer's defaults
 * for any field the spec leaves unset, mirrors the Pack Tactics /
 * Sunlight Sensitivity shape so DAE + Midi-QOL behave consistently.
 */
function writeCustomTraitEffect(
  spec: CustomTraitEffect,
  traitName: string,
  allocEffectId: () => string,
): Record<string, any> {
  const transfer = spec.transfer ?? true;
  const effect: Record<string, any> = {
    _id: allocEffectId(),
    name: spec.effectName ?? traitName,
    statuses: spec.statuses ?? [],
    transfer,
    disabled: spec.disabled ?? false,
    img: spec.img ?? 'icons/svg/aura.svg',
    type: 'base',
    system: {},
    origin: null,
    sort: 0,
    tint: '#ffffff',
    description: '',
    changes: (spec.changes ?? []).map(c => ({
      key: c.key,
      value: c.value,
      mode: c.mode ?? 0,
      priority: c.priority ?? 20,
    })),
    flags: {
      dae: {
        transfer: spec.flags?.dae?.transfer ?? transfer,
        stackable: spec.flags?.dae?.stackable ?? 'noneName',
        specialDuration: spec.flags?.dae?.specialDuration ?? [],
        ...(spec.flags?.dae?.showIcon !== undefined
          ? { showIcon: spec.flags.dae.showIcon }
          : {}),
      },
      'midi-qol': {
        forceCEOff: spec.flags?.['midi-qol']?.forceCEOff ?? true,
      },
      core: {},
    },
  };

  if (spec.duration && (spec.duration.rounds || spec.duration.seconds)) {
    effect.duration = {
      startTime: null,
      seconds: spec.duration.seconds ?? null,
      rounds: spec.duration.rounds ?? null,
      turns: null,
      startRound: null,
      startTurn: null,
      combat: null,
    };
  }

  return { effects: [effect] };
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
