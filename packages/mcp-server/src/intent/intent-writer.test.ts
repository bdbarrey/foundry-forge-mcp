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
import { writeScratchItem } from './intent-writer.js';
import type { ActionIntent } from './activity-intent.js';
import { ActionIntentSchema } from './intent-schema.js';

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

    // ActiveEffect is on the item with statuses[0] = 'restrained'.
    expect(doc.effects).toHaveLength(1);
    const eff = (doc.effects as any[])[0];
    expect(eff.statuses).toEqual(['restrained']);

    // Repeat-save → Midi OverTime change on the effect.
    expect(eff.changes).toHaveLength(1);
    expect(eff.changes[0].key).toBe('flags.midi-qol.OverTime');
    expect(eff.changes[0].value).toMatch(/turn=end/);
    expect(eff.changes[0].value).toMatch(/saveDC=14/);
    expect(eff.changes[0].value).toMatch(/saveAbility=str/);

    // Save activity links to the effect by id.
    expect(saveActivity.effects[0]._id).toBe(eff._id);
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

    // Item carries TWO ActiveEffect docs.
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
