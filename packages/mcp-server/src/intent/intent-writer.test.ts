// Phase 12.1.0 tests for the intent writer + Zod schema.
//
// Three concerns these tests address:
//
//   1. Schema acceptance — Zod validates canonical ActionIntent shapes
//      that an orchestrating Claude session would emit.
//
//   2. Writer output shape — for a hand-authored save-only intent, the
//      writer produces a recognizable dnd5e feat doc with the right
//      activities + effects + flags + uses.
//
//   3. Phase 12.1 capabilities the regex parser cannot produce:
//        - multi-condition saves (Thunderstone: prone + deafened)
//        - attack→save chains with conditionRef linking
//        - cross-field invariants enforced by ActionIntentSchema.superRefine
//
// We don't try to assert "intent-mode === parser-mode" via toEqual —
// the writer is the same code on both paths (Phase 12.0 already routed
// the parser path through it), so byte-equivalence is structural rather
// than testable. The 279 existing tests cover that.

import { describe, it, expect } from 'vitest';
import { writeScratchItem, writeTrait } from './intent-writer.js';
import type { ActionIntent, TraitIntent } from './activity-intent.js';
import { ActionIntentSchema, TraitIntentSchema } from './intent-schema.js';

function makeIdGen() {
  let n = 0;
  return () => {
    const id = `id-${String(n).padStart(13, '0')}`;
    n++;
    return id;
  };
}

function detOpts() {
  const gen = makeIdGen();
  return {
    img: 'icons/test/feat.svg',
    genItemId: gen,
    genActivityId: gen,
    genEffectId: gen,
  };
}

describe('Phase 12.1 — ActionIntentSchema (Zod) acceptance', () => {
  it('accepts a save-only intent with condition + repeat-save', () => {
    const ok = ActionIntentSchema.safeParse({
      name: 'Tanglefoot',
      description: 'AOE save-or-restrained.',
      usage: { count: 1, period: 'day' },
      activities: [
        {
          intentId: 'save',
          kind: 'save',
          name: 'Save',
          save: { ability: 'str', dc: 14 },
          range: { value: 30, units: 'ft' },
          target: { template: { shape: 'circle', size: 10 } },
          effects: [{ conditionRef: 0 }],
        },
      ],
      conditions: [
        {
          type: 'restrained',
          repeatSave: { period: 'turnEnd', ability: 'str', dc: 14 },
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a multi-condition save intent', () => {
    const ok = ActionIntentSchema.safeParse({
      name: 'Thunderstone',
      description: 'AOE save-or-prone-and-deafened.',
      activities: [
        {
          intentId: 'save',
          kind: 'save',
          name: 'Save',
          save: { ability: 'con', dc: 14 },
          target: { template: { shape: 'circle', size: 10 } },
          effects: [
            { conditionRef: 0 },
            { conditionRef: 1 },
          ],
        },
      ],
      conditions: [{ type: 'prone' }, { type: 'deafened' }],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts an attack→save chain intent', () => {
    const ok = ActionIntentSchema.safeParse({
      name: 'Bite',
      description: 'Attack hits, then Con save vs. paralysis.',
      activities: [
        {
          intentId: 'save',
          kind: 'save',
          name: 'Save',
          save: { ability: 'con', dc: 13 },
          effects: [{ conditionRef: 0 }],
        },
        {
          intentId: 'attack',
          kind: 'attack',
          name: 'Attack',
          attack: { bonus: 6, attackType: 'melee' },
          range: { reach: 5, units: 'ft' },
          target: { affects: { type: 'creature', count: 1 } },
          damage: {
            parts: [{ formula: '1d6 + 3', type: 'piercing' }],
            includeBase: false,
          },
          triggers: { activityRef: 'save', targets: 'hit' },
        },
      ],
      conditions: [{ type: 'paralyzed' }],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an intent whose effects[].conditionRef is out of range', () => {
    const result = ActionIntentSchema.safeParse({
      name: 'Bad',
      description: 'effects refers to a condition that does not exist.',
      activities: [
        {
          intentId: 'save',
          kind: 'save',
          name: 'Save',
          save: { ability: 'con', dc: 13 },
          effects: [{ conditionRef: 5 }],
        },
      ],
      conditions: [{ type: 'prone' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map(i => i.message).join('|');
      expect(msg).toMatch(/conditionRef 5 out of range/);
    }
  });

  it('rejects an intent whose triggers.activityRef does not match any intentId', () => {
    const result = ActionIntentSchema.safeParse({
      name: 'Bad',
      description: 'attack triggers a save that does not exist.',
      activities: [
        {
          intentId: 'attack',
          kind: 'attack',
          name: 'Attack',
          attack: { bonus: 5 },
          triggers: { activityRef: 'nonexistent-save', targets: 'hit' },
        },
      ],
      conditions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map(i => i.message).join('|');
      expect(msg).toMatch(/does not match any activity intentId/);
    }
  });

  it('rejects an intent with a self-referential trigger', () => {
    const result = ActionIntentSchema.safeParse({
      name: 'Bad',
      description: 'self-trigger',
      activities: [
        {
          intentId: 'attack',
          kind: 'attack',
          name: 'Attack',
          attack: { bonus: 5 },
          triggers: { activityRef: 'attack', targets: 'hit' },
        },
      ],
      conditions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map(i => i.message).join('|');
      expect(msg).toMatch(/cannot trigger itself/);
    }
  });
});

describe('Phase 12.1 — writer output shape from hand-authored intents', () => {
  it('save-only with condition produces a feat with linked ActiveEffect', () => {
    const intent: ActionIntent = {
      name: 'Tanglefoot',
      description: 'AOE save-or-restrained.',
      usage: { count: 1, period: 'day' },
      activities: [
        {
          intentId: 'save',
          kind: 'save',
          name: 'Save',
          save: { ability: 'str', dc: 14 },
          range: { value: 30, units: 'ft' },
          target: { template: { shape: 'circle', size: 10 } },
          effects: [{ conditionRef: 0, onSave: false }],
        },
      ],
      conditions: [
        {
          type: 'restrained',
          repeatSave: { period: 'turnEnd', ability: 'str', dc: 14 },
        },
      ],
    };

    const doc = writeScratchItem(intent, detOpts());

    expect(doc.type).toBe('feat');
    expect(doc.name).toBe('Tanglefoot');
    expect(doc.system.uses).toEqual({
      max: '1',
      spent: 0,
      recovery: [{ period: 'day', type: 'recoverAll', formula: '' }],
    });

    const activities: Record<string, any> = doc.system.activities;
    const saveActivity = Object.values(activities).find(a => a.type === 'save')!;
    expect(saveActivity.save).toEqual({
      ability: ['str'],
      dc: { calculation: '', formula: '14' },
    });
    expect(saveActivity.target.template).toEqual({
      type: 'circle',
      size: 10,
      units: 'ft',
    });

    // ActiveEffect is on the item with statuses[] so Midi/dnd5e auto-apply
    // the canonical condition on save fail. img matches CONFIG.statusEffects
    // so AE icon and condition icon are the same SVG (single-icon strategy
    // for dnd5e 5.x — finalized 2026-05-02).
    expect(doc.effects).toHaveLength(1);
    const eff = (doc.effects as any[])[0];
    expect(eff.statuses).toEqual(['restrained']);
    expect(eff.name).toBe('Restrained');
    expect(eff.img).toBe('systems/dnd5e/icons/svg/statuses/restrained.svg');

    // Repeat-save → Midi OverTime change on the effect.
    expect(eff.changes).toHaveLength(1);
    expect(eff.changes[0].key).toBe('flags.midi-qol.OverTime');
    expect(eff.changes[0].value).toMatch(/turn=end/);
    expect(eff.changes[0].value).toMatch(/saveDC=14/);
    expect(eff.changes[0].value).toMatch(/saveAbility=str/);

    // Save activity links to the effect by id.
    expect(saveActivity.effects[0]._id).toBe(eff._id);

    // Description retains the &Reference enricher as an informational chat-
    // card pill (clickable; doesn't auto-apply since statuses[] already
    // handles the canonical-condition application).
    expect(doc.system.description.value).toContain('&Reference[restrained]');
  });
});

describe('Phase 12.1 — capabilities the regex parser cannot produce', () => {
  it('multi-condition save (Thunderstone: prone + deafened)', () => {
    // Live-verified 2026-04-29: Thunderstone was direct-patched on Volenta
    // because the parser could only model a single ParsedCondition. The
    // intent schema supports an array, closing that gap.
    const intent: ActionIntent = {
      name: 'Thunderstone',
      description: 'Prone and deafened on failed save.',
      activities: [
        {
          intentId: 'save',
          kind: 'save',
          name: 'Save',
          save: { ability: 'con', dc: 14 },
          range: { value: 30, units: 'ft' },
          target: {
            template: { shape: 'circle', size: 10 },
            affects: { type: 'creature' },
          },
          effects: [
            { conditionRef: 0, onSave: false },
            { conditionRef: 1, onSave: false },
          ],
        },
      ],
      conditions: [
        { type: 'prone' },
        {
          type: 'deafened',
          duration: { rounds: 1, seconds: 6, specialDuration: 'turnEndSource' },
        },
      ],
    };

    const doc = writeScratchItem(intent, detOpts());

    // Item carries TWO ActiveEffect docs (one per condition).
    expect(doc.effects).toHaveLength(2);
    expect((doc.effects as any[]).map(e => e.statuses[0])).toEqual([
      'prone',
      'deafened',
    ]);

    // Save activity links BOTH effects.
    const activities: Record<string, any> = doc.system.activities;
    const saveActivity = Object.values(activities).find(a => a.type === 'save')!;
    expect(saveActivity.effects).toHaveLength(2);

    // Effect ids on the save activity match the item-level effect ids.
    const itemEffectIds = (doc.effects as any[]).map(e => e._id);
    const linkedEffectIds = saveActivity.effects.map((e: any) => e._id);
    expect(linkedEffectIds).toEqual(itemEffectIds);

    // The deafened condition emits a duration block; prone has none.
    const proneEffect = (doc.effects as any[]).find(e => e.statuses[0] === 'prone');
    const deafenedEffect = (doc.effects as any[]).find(e => e.statuses[0] === 'deafened');
    expect(proneEffect.duration).toBeUndefined();
    expect(deafenedEffect.duration).toEqual({
      startTime: null,
      seconds: 6,
      rounds: 1,
      turns: null,
      startRound: null,
      startTurn: null,
      combat: null,
    });

    // Description carries both &Reference enrichers (Midi auto-applies the
    // canonical condition statuses on save fail).
    expect(doc.system.description.value).toContain('&Reference[prone]');
    expect(doc.system.description.value).toContain('&Reference[deafened]');
  });

  it('attack→save chain (Bite-style with triggeredActivityId)', () => {
    const intent: ActionIntent = {
      name: 'Bite',
      description: 'Bite hits, then Con save vs. paralysis.',
      activities: [
        {
          intentId: 'save',
          kind: 'save',
          name: 'Save',
          save: { ability: 'con', dc: 13 },
          effects: [{ conditionRef: 0, onSave: false }],
        },
        {
          intentId: 'attack',
          kind: 'attack',
          name: 'Attack',
          attack: { bonus: 6, attackType: 'melee' },
          range: { reach: 5, units: 'ft' },
          target: { affects: { type: 'creature', count: 1 } },
          damage: {
            parts: [{ formula: '1d6 + 3', type: 'piercing' }],
            includeBase: false,
          },
          triggers: { activityRef: 'save', targets: 'hit' },
        },
      ],
      conditions: [{ type: 'paralyzed' }],
    };

    const doc = writeScratchItem(intent, detOpts());
    const activities: Record<string, any> = doc.system.activities;
    const saveActivity = Object.values(activities).find(a => a.type === 'save')!;
    const attackActivity = Object.values(activities).find(a => a.type === 'attack')!;

    // The attack's triggeredActivityId points at the save's _id.
    expect(attackActivity.midiProperties).toEqual({
      triggeredActivityId: saveActivity._id,
      triggeredActivityTargets: 'hit',
    });

    // Damage rides the attack (Bite-style: damage on attack, save resolves
    // the rider effect, not damage).
    expect(attackActivity.damage.parts).toEqual([
      { custom: { enabled: true, formula: '1d6 + 3' }, types: ['piercing'] },
    ]);

    // The save links to the paralyzed effect.
    expect(saveActivity.effects).toHaveLength(1);
    expect((doc.effects as any[])[0].statuses[0]).toBe('paralyzed');
    expect(saveActivity.effects[0]._id).toBe((doc.effects as any[])[0]._id);
  });
});

// ----- Phase 12.1.1 — TraitIntent schema + writeTrait kinds ----------------

describe('Phase 12.1.1 — TraitIntentSchema (Zod) acceptance', () => {
  it('accepts pack-tactics intent without a custom block', () => {
    expect(
      TraitIntentSchema.safeParse({
        kind: 'pack-tactics',
        name: 'Pack Tactics',
        description: '',
      }).success,
    ).toBe(true);
  });

  it('accepts description-only intent', () => {
    expect(
      TraitIntentSchema.safeParse({
        kind: 'description-only',
        name: 'Innate Spellcasting',
        description: 'Volenta is a spellcaster — see her spell list.',
      }).success,
    ).toBe(true);
  });

  it('accepts custom intent with a CustomTraitEffect', () => {
    expect(
      TraitIntentSchema.safeParse({
        kind: 'custom',
        name: 'Magic Resistance',
        description: 'Advantage on saves against spells and magical effects.',
        custom: {
          changes: [
            {
              key: 'flags.midi-qol.advantage.ability.save.all',
              value: '@attributes.spelldc',
              mode: 0,
              priority: 20,
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects custom intent missing the custom block', () => {
    const result = TraitIntentSchema.safeParse({
      kind: 'custom',
      name: 'Some Trait',
      description: 'No effect spec provided.',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map(i => i.message).join('|');
      expect(msg).toMatch(/kind='custom' requires the `custom` field/);
    }
  });
});

describe('Phase 12.1.1 — writeTrait output by kind', () => {
  function detEffectOpts() {
    let n = 0;
    return {
      genEffectId: () => {
        const id = `eff-${String(n).padStart(13, '0')}`;
        n++;
        return id;
      },
    };
  }

  it('description-only kind emits no effect block', () => {
    const out = writeTrait(
      { kind: 'description-only', name: 'Awakened Bloodlust', description: '' },
      detEffectOpts(),
    );
    expect(out).toEqual({});
  });

  it('pack-tactics kind emits the canonical findNearby effect', () => {
    const out = writeTrait(
      { kind: 'pack-tactics', name: 'Pack Tactics', description: '' },
      detEffectOpts(),
    );
    expect(out.effects).toHaveLength(1);
    const eff = (out.effects as any[])[0];
    expect(eff.name).toBe('Pack Tactics');
    expect(eff.transfer).toBe(true);
    expect(eff.changes).toHaveLength(1);
    expect(eff.changes[0]).toMatchObject({
      key: 'flags.midi-qol.advantage.attack.all',
      value: 'findNearby(-1, targetUuid, 5, 0).length > 1',
      mode: 0,
      priority: 20,
    });
  });

  it('sunlight-sensitivity kind emits the disabled-by-default effect', () => {
    const out = writeTrait(
      {
        kind: 'sunlight-sensitivity',
        name: 'Sunlight Hypersensitivity',
        description: '',
      },
      detEffectOpts(),
    );
    expect(out.effects).toHaveLength(1);
    const eff = (out.effects as any[])[0];
    expect(eff.disabled).toBe(true);
    expect(eff.changes).toHaveLength(2);
    expect(eff.changes.map((c: any) => c.key)).toEqual([
      'flags.midi-qol.disadvantage.attack.all',
      'flags.midi-qol.disadvantage.ability.check.all',
    ]);
  });

  it('custom kind emits caller-supplied changes with writer defaults', () => {
    const intent: TraitIntent = {
      kind: 'custom',
      name: 'Magic Resistance',
      description: 'Advantage on saves vs magic.',
      custom: {
        changes: [
          {
            key: 'flags.midi-qol.advantage.ability.save.all',
            value: '@attributes.spellLevel',
          },
          { key: 'flags.midi-qol.magicResistance', value: '1' },
        ],
      },
    };
    const out = writeTrait(intent, detEffectOpts());
    expect(out.effects).toHaveLength(1);
    const eff = (out.effects as any[])[0];

    // Caller-supplied keys + values pass through.
    expect(eff.changes).toHaveLength(2);
    expect(eff.changes[0].key).toBe('flags.midi-qol.advantage.ability.save.all');
    expect(eff.changes[1].key).toBe('flags.midi-qol.magicResistance');

    // Writer fills mode/priority defaults.
    expect(eff.changes[0].mode).toBe(0);
    expect(eff.changes[0].priority).toBe(20);

    // Writer defaults: transfer=true (always-on), disabled=false, statuses=[],
    // DAE flags + Midi forceCEOff.
    expect(eff.transfer).toBe(true);
    expect(eff.disabled).toBe(false);
    expect(eff.statuses).toEqual([]);
    expect(eff.flags.dae.transfer).toBe(true);
    expect(eff.flags.dae.stackable).toBe('noneName');
    expect(eff.flags['midi-qol'].forceCEOff).toBe(true);

    // Effect name defaults to the trait name.
    expect(eff.name).toBe('Magic Resistance');
  });

  it('custom kind respects caller overrides for transfer/disabled/img/effectName', () => {
    const intent: TraitIntent = {
      kind: 'custom',
      name: 'Sunlight Sensitivity',
      description: '',
      custom: {
        effectName: 'Sunlight Sensitivity (custom)',
        img: 'icons/magic/light/test.webp',
        transfer: true,
        disabled: true,
        changes: [{ key: 'flags.midi-qol.disadvantage.attack.all', value: '1' }],
      },
    };
    const out = writeTrait(intent, detEffectOpts());
    const eff = (out.effects as any[])[0];
    expect(eff.name).toBe('Sunlight Sensitivity (custom)');
    expect(eff.img).toBe('icons/magic/light/test.webp');
    expect(eff.disabled).toBe(true);
  });

  it('custom kind emits a duration block when specified', () => {
    const intent: TraitIntent = {
      kind: 'custom',
      name: 'Temporary Resistance',
      description: 'Effect lasts 1 minute.',
      custom: {
        changes: [{ key: 'system.traits.dr.value', value: 'fire' }],
        duration: { rounds: 10, seconds: 60 },
      },
    };
    const out = writeTrait(intent, detEffectOpts());
    const eff = (out.effects as any[])[0];
    expect(eff.duration).toEqual({
      startTime: null,
      seconds: 60,
      rounds: 10,
      turns: null,
      startRound: null,
      startTurn: null,
      combat: null,
    });
  });

  // 2026-05-02 — three trait kinds added to fix Volenta build gap. The previous
  // build had Regeneration and Sunlight Hypersensitivity as description-only
  // feats, so Regeneration didn't fire and Hypersensitivity was missing the
  // 20 radiant damage tick. User reported "regeneration doesnt apply at the
  // start of her turn" — this suite locks the canonical Midi shapes.

  it('regeneration kind emits OverTime healing with parsed amount + max-HP condition', () => {
    const out = writeTrait(
      {
        kind: 'regeneration',
        name: 'Regeneration',
        description:
          'Volenta regains 10 hit points at the start of her turn if she has at least 1 hit point and isn\'t in sunlight or running water.',
      },
      detEffectOpts(),
    );
    expect(out.effects).toHaveLength(1);
    const eff = (out.effects as any[])[0];
    expect(eff.name).toBe('Regeneration');
    expect(eff.transfer).toBe(true);
    expect(eff.disabled).toBe(false);
    expect(eff.changes).toHaveLength(1);
    const change = eff.changes[0];
    expect(change.key).toBe('flags.midi-qol.OverTime.regeneration');
    expect(change.value).toContain('turn=start');
    expect(change.value).toContain('damageRoll=10');
    expect(change.value).toContain('damageType=healing');
    // Skip-at-max-HP condition — answers user's "shouldn't fire at max HP" intuition.
    expect(change.value).toContain('condition=@attributes.hp.value<@attributes.hp.max');
    expect(change.mode).toBe(0);
  });

  it('regeneration kind parses non-default heal amounts (Troll = 10, Pit Fiend = 20)', () => {
    const troll = writeTrait(
      { kind: 'regeneration', name: 'Regeneration', description: 'The troll regains 15 hit points at the start of its turn.' },
      detEffectOpts(),
    );
    expect((troll.effects as any[])[0].changes[0].value).toContain('damageRoll=15');

    const noNumber = writeTrait(
      { kind: 'regeneration', name: 'Regeneration', description: 'It heals over time.' },
      detEffectOpts(),
    );
    // Defaults to 10 when description has no parseable amount.
    expect((noNumber.effects as any[])[0].changes[0].value).toContain('damageRoll=10');
  });

  it('sunlight-hypersensitivity emits BOTH OverTime damage AND disadvantage flags', () => {
    const out = writeTrait(
      {
        kind: 'sunlight-hypersensitivity',
        name: 'Sunlight Hypersensitivity',
        description:
          'While in sunlight, Volenta takes 20 radiant damage at the start of her turn, and she has disadvantage on attack rolls and ability checks.',
      },
      detEffectOpts(),
    );
    expect(out.effects).toHaveLength(1);
    const eff = (out.effects as any[])[0];
    expect(eff.disabled).toBe(true); // GM-toggled — same as plain Sunlight Sensitivity
    const keys = eff.changes.map((c: any) => c.key);
    expect(keys).toContain('flags.midi-qol.OverTime.sunlightHypersensitivity');
    expect(keys).toContain('flags.midi-qol.disadvantage.attack.all');
    expect(keys).toContain('flags.midi-qol.disadvantage.ability.check.all');
    const overtime = eff.changes.find((c: any) => c.key === 'flags.midi-qol.OverTime.sunlightHypersensitivity');
    expect(overtime.value).toContain('damageRoll=20');
    expect(overtime.value).toContain('damageType=radiant');
  });

  it('sunlight-hypersensitivity parses non-default damage amounts', () => {
    const out = writeTrait(
      {
        kind: 'sunlight-hypersensitivity',
        name: 'Sunlight Hypersensitivity',
        description: 'It takes 30 radiant damage at the start of its turn.',
      },
      detEffectOpts(),
    );
    const eff = (out.effects as any[])[0];
    const overtime = eff.changes.find((c: any) => c.key === 'flags.midi-qol.OverTime.sunlightHypersensitivity');
    expect(overtime.value).toContain('damageRoll=30');
  });

  it('magic-resistance emits the magicResistance.all advantage flag (always-on)', () => {
    const out = writeTrait(
      { kind: 'magic-resistance', name: 'Magic Resistance', description: 'Advantage on saves vs spells and magical effects.' },
      detEffectOpts(),
    );
    expect(out.effects).toHaveLength(1);
    const eff = (out.effects as any[])[0];
    expect(eff.disabled).toBe(false); // Always-on
    expect(eff.changes).toHaveLength(1);
    expect(eff.changes[0]).toMatchObject({
      key: 'flags.midi-qol.magicResistance.all',
      value: '1',
      mode: 0,
    });
  });
});
