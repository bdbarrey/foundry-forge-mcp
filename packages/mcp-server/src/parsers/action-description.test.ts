import { describe, expect, it } from 'vitest';
import { parseActionDescription, parseUsageMarker } from './action-description.js';

describe('parseActionDescription — Wight Commander Life Drain', () => {
  const desc =
    'Melee Weapon Attack: +7 to hit, reach 5 ft., one creature. ' +
    'Hit: 10 (2d6 + 3) necrotic damage and the target is grappled (escape DC 15). ' +
    'The wight commander and all non-hostile undead within 10 feet of it regain hit points equal to half the necrotic damage dealt. ' +
    'In addition, the target must succeed on a DC 14 Constitution saving throw or have its hit point maximum be reduced by an amount equal to the damage taken.';
  const r = parseActionDescription(desc)!;

  it('recognizes melee attack with bonus and reach', () => {
    expect(r.attackType).toBe('melee');
    expect(r.attackBonus).toBe(7);
    expect(r.reach).toBe(5);
  });

  it('captures target text', () => {
    expect(r.target).toBe('one creature');
  });

  it('extracts necrotic damage formula', () => {
    expect(r.damage).toEqual([{ formula: '2d6 + 3', type: 'necrotic' }]);
  });

  it('extracts the DC 14 Constitution save (and ignores the DC 15 escape mention)', () => {
    expect(r.save).toEqual({ dc: 14, ability: 'con' });
  });
});

describe('parseActionDescription — Longsword (versatile)', () => {
  const desc =
    'Melee Weapon Attack: +7 to hit, reach 5 ft., one target. ' +
    'Hit: 13 (2d8 + 4) slashing damage, or 15 (2d10 + 4) slashing damage if used with two hands.';
  const r = parseActionDescription(desc)!;

  it('parses attack + reach + target', () => {
    expect(r.attackType).toBe('melee');
    expect(r.attackBonus).toBe(7);
    expect(r.reach).toBe(5);
    expect(r.target).toBe('one target');
  });

  it('captures primary damage and versatile damage separately', () => {
    expect(r.damage).toEqual([{ formula: '2d8 + 4', type: 'slashing' }]);
    expect(r.versatile).toEqual({ formula: '2d10 + 4', type: 'slashing' });
  });

  it('no save on a straight weapon attack', () => {
    expect(r.save).toBeUndefined();
  });
});

describe('parseActionDescription — Longbow (ranged)', () => {
  const desc =
    'Ranged Weapon Attack: +5 to hit, range 150/600 ft., one target. ' +
    'Hit: 11 (2d8 + 2) piercing damage.';
  const r = parseActionDescription(desc)!;

  it('parses ranged attack with normal/long range', () => {
    expect(r.attackType).toBe('ranged');
    expect(r.attackBonus).toBe(5);
    expect(r.range).toEqual({ normal: 150, long: 600 });
    expect(r.reach).toBeUndefined();
  });

  it('parses single damage entry', () => {
    expect(r.damage).toEqual([{ formula: '2d8 + 2', type: 'piercing' }]);
  });
});

describe('parseActionDescription — Plague Spreader Slam (multi-type damage)', () => {
  const desc =
    'Melee Weapon Attack: +5 to hit, reach 5 ft., one target. ' +
    'Hit: 6 (1d6 + 3) bludgeoning damage plus 9 (2d8) necrotic damage.';
  const r = parseActionDescription(desc)!;

  it('captures both damage entries in order', () => {
    expect(r.damage).toEqual([
      { formula: '1d6 + 3', type: 'bludgeoning' },
      { formula: '2d8', type: 'necrotic' },
    ]);
  });
});

describe('parseActionDescription — Virulent Miasma (save + AoE + usage)', () => {
  const desc =
    'The plague spreader releases toxic gas in a 30-foot-radius sphere centered on itself. ' +
    'Each creature in that area must make a DC 12 Constitution saving throw, ' +
    'taking 14 (4d6) poison damage on a failed save, or half as much on a successful one.';
  const r = parseActionDescription(desc)!;

  it('has no attack bonus (save-only action)', () => {
    expect(r.attackType).toBeUndefined();
    expect(r.attackBonus).toBeUndefined();
  });

  it('parses save with ability + DC + half-on-success', () => {
    expect(r.save).toEqual({ dc: 12, ability: 'con', onSuccess: 'half' });
  });

  it('parses the damage formula', () => {
    expect(r.damage).toEqual([{ formula: '4d6', type: 'poison' }]);
  });

  it('usage is recognized separately when passed via parseUsageMarker', () => {
    // Reloaded prints (1/Day) in the feature NAME, not inside the description,
    // so the description alone doesn't carry usage — the caller composes it.
    expect(parseUsageMarker('Virulent Miasma (1/Day)')).toEqual({ count: 1, period: 'day' });
  });
});

describe('parseUsageMarker', () => {
  it('extracts per-day counts', () => {
    expect(parseUsageMarker('Dispel Magic (3/Day)')).toEqual({ count: 3, period: 'day' });
  });

  it('extracts Recharge X-Y ranges', () => {
    expect(parseUsageMarker('Fire Breath (Recharge 5-6)')).toEqual({ recharge: [5, 6] });
  });

  it('recognizes "Recharges after a Long Rest"', () => {
    expect(parseUsageMarker('Psychic Scream. Recharges after a long rest.'))
      .toEqual({ count: 1, period: 'long-rest' });
  });

  it('returns undefined when no marker present', () => {
    expect(parseUsageMarker('Multiattack')).toBeUndefined();
  });
});

describe('parseActionDescription — edge cases', () => {
  it('returns null for empty input', () => {
    expect(parseActionDescription('')).toBeNull();
    expect(parseActionDescription('   ')).toBeNull();
  });

  it('returns a near-empty ParsedAction for pure narrative (no attack, no save, no damage)', () => {
    const r = parseActionDescription('The wight commander makes two attacks.')!;
    expect(r.attackBonus).toBeUndefined();
    expect(r.save).toBeUndefined();
    expect(r.damage).toEqual([]);
  });

  it('handles en-dash / minus normalization in damage formulas', () => {
    const r = parseActionDescription(
      'Melee Weapon Attack: +3 to hit, reach 5 ft., one target. Hit: 4 (1d6 – 1) bludgeoning damage.',
    )!;
    expect(r.damage).toEqual([{ formula: '1d6 - 1', type: 'bludgeoning' }]);
  });
});
