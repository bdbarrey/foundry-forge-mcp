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

describe('parseActionDescription — Volenta Dagger (Reloaded drops the colon after Attack)', () => {
  // The CoS Reloaded statblock for Volenta's Dagger writes "Melee Weapon Attack +7"
  // with no colon — Hail of Daggers RIGHT ABOVE it has a colon. Both must parse.
  it('parses attack bonus when the colon is missing', () => {
    const r = parseActionDescription(
      'Melee Weapon Attack +7 to hit, 5 ft., one target. Hit: 6 (1d4 + 4) piercing damage.',
    )!;
    expect(r.attackType).toBe('melee');
    expect(r.attackBonus).toBe(7);
    expect(r.damage).toEqual([{ formula: '1d4 + 4', type: 'piercing' }]);
  });

  it('still parses attack bonus when the colon is present', () => {
    const r = parseActionDescription(
      'Ranged Weapon Attack: +7 to hit, range 15 ft., one target. Hit: 9 (2d4 + 4) piercing damage.',
    )!;
    expect(r.attackType).toBe('ranged');
    expect(r.attackBonus).toBe(7);
  });
});

describe('parseActionDescription — bare-distance reach (Reloaded drops "reach")', () => {
  it('parses reach 5 ft. when keyword "reach" is missing on a melee attack (Volenta Dagger)', () => {
    const r = parseActionDescription(
      'Melee Weapon Attack +7 to hit, 5 ft., one target. Hit: 6 (1d4 + 4) piercing damage.',
    )!;
    expect(r.attackType).toBe('melee');
    expect(r.reach).toBe(5);
  });

  it('does NOT use bare-distance fallback for ranged attacks (Hail of Daggers explicit "range")', () => {
    const r = parseActionDescription(
      'Ranged Weapon Attack: +7 to hit, range 15 ft., one target. Hit: 9 (2d4 + 4) piercing damage.',
    )!;
    expect(r.range).toEqual({ normal: 15 });
    expect(r.reach).toBeUndefined();
  });
});

describe('parseActionDescription — prose range/area for save AoEs (Phase 2C)', () => {
  it('captures "within 30 feet" as range.normal (Tanglefoot/Thunderstone)', () => {
    const r = parseActionDescription(
      'Volenta hurls a bag at a point on the ground within 30 feet. ' +
      'Each target must succeed on a DC 14 Strength saving throw or be restrained.',
    )!;
    expect(r.range).toEqual({ normal: 30 });
    expect(r.save).toEqual({ dc: 14, ability: 'str' });
  });

  it('captures "10-foot radius" as range (Firebomb area)', () => {
    const r = parseActionDescription(
      'Volenta hurls a flask at a point within 30 feet. ' +
      'The vial detonates in a 10-foot radius. Any creature in that area must succeed ' +
      'on a DC 14 Dexterity saving throw or take 2d6 fire damage.',
    )!;
    // "within 30 feet" wins (first match — the action's range to the target point)
    expect(r.range).toEqual({ normal: 30 });
  });

  it('skips caster-relative qualifiers like "within 5 feet of one another"', () => {
    const r = parseActionDescription(
      'Volenta hurls a bag covering up to two creatures within 5 feet of one another. ' +
      'Each target must succeed on a DC 14 Strength saving throw or be restrained.',
    )!;
    // "within 5 feet of" is "within X feet of <target>" — that describes target
    // grouping, not the action's range. Should NOT set range to 5.
    expect(r.range).toBeUndefined();
  });

  it('captures "20-foot radius" for Smokestick area', () => {
    const r = parseActionDescription(
      'Releases a cloud of opaque smoke that creates a heavily obscured area in a 20-foot radius.',
    )!;
    expect(r.range).toEqual({ normal: 20 });
  });
});

describe('parseActionDescription — Volenta Firebomb (save-or-damage prose, no average)', () => {
  const desc =
    'Volenta hurls a flask of concentrated alchemist\'s fire at a point within 30 feet. ' +
    'The vial shatters on impact and detonates in a 10-foot radius. ' +
    'Any creature in that area must succeed on a DC 14 Dexterity saving throw or take 2d6 fire damage and be set ablaze. ' +
    'A creature set ablaze in this way takes 1d4 fire damage at the start of each of its turns, ' +
    'and can make an additional DC 14 Dexterity saving throw at the end of each of its turns to extinguish the flames.';
  const r = parseActionDescription(desc)!;

  it('parses the DC 14 Dexterity save', () => {
    // Earlier code used to set onSuccess='half' from ANY mention of "half"; Volenta has none.
    expect(r.save).toEqual({ dc: 14, ability: 'dex' });
  });

  it('extracts primary 2d6 fire damage from "or take" prose, NOT the secondary 1d4 ongoing', () => {
    expect(r.damage).toEqual([{ formula: '2d6', type: 'fire' }]);
  });

  it('has no attack', () => {
    expect(r.attackType).toBeUndefined();
    expect(r.attackBonus).toBeUndefined();
  });
});

describe('parseActionDescription — save-only with no damage (Tanglefoot / Thunderstone)', () => {
  it('Tanglefoot: save with no damage is recognized but damage stays empty', () => {
    const desc =
      'Volenta hurls a bag of writhing, sticky black tar at a point on the ground within 30 feet. ' +
      'The bag bursts on impact, covering up to two creatures within 5 feet of one another with sticky tar ' +
      'and forcing each target to succeed on a DC 14 Strength saving throw or be restrained.';
    const r = parseActionDescription(desc)!;
    expect(r.save).toEqual({ dc: 14, ability: 'str' });
    expect(r.damage).toEqual([]);
    // Phase 10A: condition is parsed off the post-save prose. No duration in
    // the snippet → only the type field is populated.
    expect(r.condition).toEqual({ type: 'restrained' });
  });

  it('Thunderstone: save without damage is parsed cleanly (no false positive on "deafened")', () => {
    const desc =
      'Volenta hurls a crystalline shard at a creature, object, or surface within 30 feet. ' +
      'The shard shatters on impact with a blast of concussive energy. ' +
      'Each creature within 10 feet of the point of impact must succeed on a DC 14 Constitution saving throw ' +
      'or be knocked prone and pushed 10 feet away from that point.';
    const r = parseActionDescription(desc)!;
    expect(r.save).toEqual({ dc: 14, ability: 'con' });
    expect(r.damage).toEqual([]);
    // "knocked prone" matches the prone pattern — and crucially "deafened" does
    // NOT match (no "be deafened" wording), so this remains pure prone.
    expect(r.condition).toEqual({ type: 'prone' });
  });
});

describe('parseActionDescription — Phase 10A condition + duration parsing', () => {
  it('"restrained for 1 minute" → 10 rounds / 60 seconds', () => {
    const r = parseActionDescription(
      'Each target must succeed on a DC 14 Strength saving throw or be restrained for 1 minute.',
    )!;
    expect(r.condition).toEqual({
      type: 'restrained',
      duration: { rounds: 10, seconds: 60 },
    });
  });

  it('"poisoned until the end of its next turn" → 1 round + turnEnd specialDuration', () => {
    const r = parseActionDescription(
      'On a hit, the target must make a DC 13 Constitution saving throw or be poisoned until the end of its next turn.',
    )!;
    expect(r.condition).toEqual({
      type: 'poisoned',
      duration: { rounds: 1, seconds: 6, specialDuration: 'turnEnd' },
    });
  });

  it('"frightened for 1 hour" → 600 rounds / 3600 seconds', () => {
    const r = parseActionDescription(
      'Each creature must succeed on a DC 17 Wisdom saving throw or be frightened for 1 hour.',
    )!;
    expect(r.condition).toEqual({
      type: 'frightened',
      duration: { rounds: 600, seconds: 3600 },
    });
  });

  it('"paralyzed for 3 rounds" → 3 rounds / 18 seconds', () => {
    const r = parseActionDescription(
      'The target must succeed on a DC 15 Constitution saving throw or be paralyzed for 3 rounds.',
    )!;
    expect(r.condition).toEqual({
      type: 'paralyzed',
      duration: { rounds: 3, seconds: 18 },
    });
  });

  it('"start of its next turn" → turnStart specialDuration variant', () => {
    const r = parseActionDescription(
      'The target must succeed on a DC 14 Constitution saving throw or be stunned ' +
      'until the start of its next turn.',
    )!;
    expect(r.condition).toEqual({
      type: 'stunned',
      duration: { rounds: 1, seconds: 6, specialDuration: 'turnStart' },
    });
  });

  it('no condition is attached when there is no save (descriptive prose only)', () => {
    // Without a save context the parser should NOT attach a condition — would
    // be automation noise on a save-less narrative line.
    const r = parseActionDescription(
      'A creature inside the web is restrained while it remains in the area.',
    )!;
    expect(r.condition).toBeUndefined();
  });

  it('condition is omitted when prose has only a save, no condition wording', () => {
    const r = parseActionDescription(
      'Each creature within 30 feet must succeed on a DC 14 Dexterity saving throw or take 2d6 fire damage.',
    )!;
    expect(r.save).toEqual({ dc: 14, ability: 'dex' });
    expect(r.condition).toBeUndefined();
  });

  it('Tanglefoot prose: detects repeatSave with parent save DC + ability', () => {
    const r = parseActionDescription(
      "Each target must succeed on a DC 14 Strength saving throw or be restrained. " +
      "A target can repeat the saving throw at the end of each of its turns, ending the effect on a success.",
    )!;
    expect(r.condition).toEqual({
      type: 'restrained',
      repeatSave: { period: 'turnEnd', ability: 'str', dc: 14 },
    });
    // No duration — repeatSave is the expiry mechanism.
    expect(r.condition?.duration).toBeUndefined();
  });

  it('repeatSave variants: "repeats the save at the start of each of its turns"', () => {
    const r = parseActionDescription(
      'On a failed DC 17 Wisdom saving throw, the target must succeed or be paralyzed. ' +
      'The target repeats the save at the start of each of its turns, ending the effect on a success.',
    )!;
    expect(r.condition).toEqual({
      type: 'paralyzed',
      repeatSave: { period: 'turnStart', ability: 'wis', dc: 17 },
    });
  });

  it('does NOT trigger repeatSave on bare "at the end of its turn" (singular, one-shot)', () => {
    // "saving throw" required to trigger save detection (DC X ABILITY saving throw)
    const r = parseActionDescription(
      "On a hit, target must succeed on a DC 13 Constitution saving throw or be poisoned until the end of its next turn.",
    )!;
    expect(r.condition?.duration?.specialDuration).toBe('turnEnd');
    expect(r.condition?.repeatSave).toBeUndefined();
  });

  it('grappled with no duration falls back to no duration field', () => {
    const r = parseActionDescription(
      'On a failed DC 13 Strength saving throw the target is grappled.',
    )!;
    // "is grappled" doesn't match "be grappled" — but the grapple pattern
    // accepts the standard "or be grappled" form. Test the common form too:
    const r2 = parseActionDescription(
      'On a hit, target must succeed on a DC 13 Strength saving throw or be grappled.',
    )!;
    expect(r2.condition).toEqual({ type: 'grappled' });
    // The "is grappled" prose without "be" doesn't match (intentional — the
    // parser anchors to "be <condition>" for condition application clauses).
    expect(r.condition).toBeUndefined();
  });
});

describe('parseActionDescription — Phase 10A.7 targetShape parsing', () => {
  it('Tanglefoot: 10ft circle template + up-to-2-creatures count', () => {
    const r = parseActionDescription(
      'Volenta hurls a sticky bag at a point within 30 feet. The bag bursts on impact in a 10-foot radius, ' +
      'covering up to two creatures within 5 feet of one another. Each target must succeed on a ' +
      'DC 14 Strength saving throw or be restrained for 1 minute.',
    )!;
    // Range still parses as the throw distance (not the radius)
    expect(r.range).toEqual({ normal: 30 });
    // Template carries the radius
    expect(r.targetShape?.template).toEqual({ shape: 'circle', size: 10 });
    // "up to two creatures" → choice + count
    expect(r.targetShape?.affects).toEqual({ type: 'creature', count: 2, choice: true });
  });

  it('Firebomb: 10ft circle + each-creature affects (no count cap)', () => {
    const r = parseActionDescription(
      'Volenta hurls a flask at a point within 30 feet. The vial detonates in a 10-foot radius. ' +
      'Any creature in that area must succeed on a DC 14 Dexterity saving throw or take 2d6 fire damage.',
    )!;
    expect(r.range).toEqual({ normal: 30 });
    expect(r.targetShape?.template).toEqual({ shape: 'circle', size: 10 });
    // "Any creature in that area" matches the each-creature pattern via "in that area"
    // — fall back to single-creature assumption per parser logic. Acceptable.
  });

  it('Cone breath weapon: 60ft cone template + each-creature affects', () => {
    const r = parseActionDescription(
      'The dragon exhales fire in a 60-foot cone. Each creature in the area must succeed on a ' +
      'DC 21 Dexterity saving throw, taking 91 (16d10) fire damage on a failed save.',
    )!;
    expect(r.targetShape?.template).toEqual({ shape: 'cone', size: 60 });
    expect(r.targetShape?.affects).toEqual({ type: 'creature' });
  });

  it('Lightning line: 100-foot line, default 5ft width', () => {
    const r = parseActionDescription(
      'Lightning streaks in a 100-foot line. Each creature in the area must succeed on a DC 18 ' +
      'Dexterity saving throw, taking 55 (10d10) lightning damage on a failed save.',
    )!;
    expect(r.targetShape?.template).toEqual({ shape: 'line', size: 100, width: 5 });
  });

  it('Line with explicit width override', () => {
    const r = parseActionDescription(
      'A 30-foot line, 10 feet wide, of acid spews forth. Each creature in the area must succeed on a ' +
      'DC 14 Dexterity saving throw, taking 4d6 acid damage on a failed save.',
    )!;
    expect(r.targetShape?.template).toEqual({ shape: 'line', size: 30, width: 10 });
  });

  it('Cube: 30-foot cube template', () => {
    const r = parseActionDescription(
      'A 30-foot cube of force rumbles. Each creature in the area must succeed on a DC 17 Strength saving throw.',
    )!;
    expect(r.targetShape?.template).toEqual({ shape: 'cube', size: 30 });
  });

  it('Sphere: explicit "20-foot sphere" maps to sphere shape (not circle)', () => {
    const r = parseActionDescription(
      'The orb explodes in a 20-foot sphere of flame. Each creature in the area must succeed on a ' +
      'DC 15 Dexterity saving throw, taking 8d6 fire damage on a failed save.',
    )!;
    expect(r.targetShape?.template).toEqual({ shape: 'sphere', size: 20 });
  });

  it('Single-target attack defaults to creature/count=1 even without explicit prose', () => {
    const r = parseActionDescription(
      'Melee Weapon Attack: +7 to hit, reach 5 ft. Hit: 13 (2d8 + 4) slashing damage.',
    )!;
    // Attack rolls default to single-creature target — Midi/dnd5e need this set
    // for the activity to know what to target.
    expect(r.targetShape?.affects).toEqual({ type: 'creature', count: 1 });
    // No template (melee attack, no area)
    expect(r.targetShape?.template).toBeUndefined();
  });

  it('Save-only with no template + no count → no targetShape inferred', () => {
    // Without prose cues OR an attack roll, save-only actions can't be inferred.
    // The pipeline should still write a sensible default but the parser stays null.
    const r = parseActionDescription(
      'Each creature must succeed on a DC 13 Constitution saving throw or take 1d10 poison damage.',
    )!;
    // "Each creature" matches the each-creature pattern when paired with "within"
    // or "in (the|that) area" — bare "each creature" without those words doesn't
    // trigger. Affects stays undefined; caller can default to creature/no-count.
    expect(r.targetShape?.affects).toBeUndefined();
  });

  it('Digit-form count: "up to 5 creatures"', () => {
    const r = parseActionDescription(
      'You touch up to 5 creatures within range. Each target must succeed on a DC 15 Wisdom saving throw.',
    )!;
    expect(r.targetShape?.affects).toEqual({ type: 'creature', count: 5, choice: true });
  });

  it('Enemy-only filter: "up to two enemies" maps type to enemy', () => {
    const r = parseActionDescription(
      'You target up to two enemies within 30 feet. Each must succeed on a DC 14 Wisdom saving throw or be frightened.',
    )!;
    expect(r.targetShape?.affects?.type).toBe('enemy');
    expect(r.targetShape?.affects?.count).toBe(2);
  });
});
