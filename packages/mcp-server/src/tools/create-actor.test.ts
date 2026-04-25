import { describe, it, expect } from 'vitest';
import { buildItemActivityUpdate } from './create-actor.js';
import type { ParsedAction } from '../parsers/action-description.js';

describe('buildItemActivityUpdate', () => {
  it('writes save+damage+onSave for a save-only activity (Firebomb shape)', () => {
    const parsed: ParsedAction = {
      damage: [{ formula: '2d6', type: 'fire' }],
      save: { dc: 14, ability: 'dex', onSuccess: 'half' },
    };
    const activities = {
      bYwDKka1GyrEBxb9: { type: 'save' },
    };
    const update = buildItemActivityUpdate('itemA', activities, parsed);

    expect(update._id).toBe('itemA');
    expect(update['system.activities.bYwDKka1GyrEBxb9.save']).toEqual({
      ability: ['dex'],
      dc: { calculation: '', formula: '14' },
    });
    expect(update['system.activities.bYwDKka1GyrEBxb9.damage.parts']).toEqual([
      { custom: { enabled: true, formula: '2d6' }, types: ['fire'] },
    ]);
    expect(update['system.activities.bYwDKka1GyrEBxb9.damage.onSave']).toBe('half');
  });

  it('does not write damage on the save activity when an attack activity also exists', () => {
    const parsed: ParsedAction = {
      damage: [{ formula: '2d6', type: 'necrotic' }],
      attackBonus: 7,
      attackType: 'melee',
      reach: 5,
      save: { dc: 13, ability: 'con' },
    };
    const activities = {
      attackId: { type: 'attack' },
      saveId: { type: 'save' },
    };
    const update = buildItemActivityUpdate('itemB', activities, parsed);

    // Damage lands on the attack activity only
    expect(update['system.activities.attackId.damage.parts']).toEqual([
      { custom: { enabled: true, formula: '2d6' }, types: ['necrotic'] },
    ]);
    expect(update['system.activities.saveId.damage.parts']).toBeUndefined();

    // Save activity still gets DC + ability
    expect(update['system.activities.saveId.save']).toEqual({
      ability: ['con'],
      dc: { calculation: '', formula: '13' },
    });

    // Attack metadata
    expect(update['system.activities.attackId.attack.bonus']).toBe('+7');
    expect(update['system.activities.attackId.range.reach']).toBe(5);
    expect(update['system.activities.attackId.range.units']).toBe('ft');
  });

  it('writes ranged attack range.value on the attack activity (Hail of Daggers shape)', () => {
    const parsed: ParsedAction = {
      damage: [{ formula: '2d4 + 4', type: 'piercing' }],
      attackBonus: 7,
      attackType: 'ranged',
      range: { normal: 15 },
    };
    const activities = { attackId: { type: 'attack' } };
    const update = buildItemActivityUpdate('itemC', activities, parsed);

    expect(update['system.activities.attackId.attack.bonus']).toBe('+7');
    expect(update['system.activities.attackId.attack.type.value']).toBe('ranged');
    expect(update['system.activities.attackId.range.value']).toBe(15);
    expect(update['system.activities.attackId.range.units']).toBe('ft');
    expect(update['system.activities.attackId.damage.parts']).toEqual([
      { custom: { enabled: true, formula: '2d4 + 4' }, types: ['piercing'] },
    ]);
  });

  it('routes save-only damage to the save activity even when base has attack+save (Firebomb on Alchemist\'s Fire base)', () => {
    // dnd5e 5.x's Alchemist's Fire ships with TWO activities (Midi Attack +
    // Midi Save). Volenta's Firebomb Reloaded prose is save-only ("must
    // succeed... or take 2d6 fire damage"). Damage should land on the save
    // activity — the prose has no attack bonus to anchor an attack roll.
    const parsed: ParsedAction = {
      damage: [{ formula: '2d6', type: 'fire' }],
      save: { dc: 14, ability: 'dex' },
    };
    const activities = {
      attackId: { type: 'attack' },
      saveId: { type: 'save' },
    };
    const update = buildItemActivityUpdate('itemE', activities, parsed);

    // Damage on save, not on attack
    expect(update['system.activities.saveId.damage.parts']).toEqual([
      { custom: { enabled: true, formula: '2d6' }, types: ['fire'] },
    ]);
    expect(update['system.activities.attackId.damage.parts']).toBeUndefined();

    // Save still gets DC + ability
    expect(update['system.activities.saveId.save']).toEqual({
      ability: ['dex'],
      dc: { calculation: '', formula: '14' },
    });

    // No attack overrides written (parsed had no attack bonus)
    expect(update['system.activities.attackId.attack.bonus']).toBeUndefined();
  });

  it('returns only _id (no activity keys) when parsed has neither attack nor save nor damage', () => {
    const parsed: ParsedAction = { damage: [] };
    const activities = { saveId: { type: 'save' } };
    const update = buildItemActivityUpdate('itemD', activities, parsed);

    expect(Object.keys(update)).toEqual(['_id']);
  });
});
