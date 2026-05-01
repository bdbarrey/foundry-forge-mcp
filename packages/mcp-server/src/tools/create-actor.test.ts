import { describe, it, expect } from 'vitest';
import { buildItemActivityUpdate, selectPruneCandidates, PRUNE_HARD_CAP, derivePBFromCR, stripUsageSuffix, buildUsesPayload, buildConditionEffect, buildActivityTarget } from './create-actor.js';
import type { ParsedAction, ParsedCondition } from '../parsers/action-description.js';

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
    // attack.flat=true so dnd5e treats +7 as the full to-hit, not as a bonus
    // added to ability+prof (which would yield +14 on a Dex 18 / prof +3 statblock).
    expect(update['system.activities.attackId.attack.flat']).toBe(true);
    expect(update['system.activities.attackId.attack.type.value']).toBe('ranged');
    expect(update['system.activities.attackId.range.value']).toBe(15);
    expect(update['system.activities.attackId.range.units']).toBe('ft');
    // Phase 3a-polish #1: range.override=true required, otherwise dnd5e treats
    // activity range as derived-from-item and the compendium base's value
    // (e.g. 30 ft on thrown daggers) bleeds through despite our 15.
    expect(update['system.activities.attackId.range.override']).toBe(true);
    expect(update['system.activities.attackId.damage.parts']).toEqual([
      { custom: { enabled: true, formula: '2d4 + 4' }, types: ['piercing'] },
    ]);
    // Phase 1A: suppress base contribution when damage is overridden, otherwise
    // dnd5e adds the weapon's base die on top (Hail of Daggers becomes 4d4+8
    // instead of 2d4+4).
    expect(update['system.activities.attackId.damage.includeBase']).toBe(false);
  });

  it('writes range.override on melee reach + on save-activity range (Phase 3a-polish #1)', () => {
    // Melee reach: range.override must accompany reach for the same reason
    // (compendium base's reach can be 0/null and bleed in).
    const meleeParsed: ParsedAction = {
      damage: [{ formula: '1d8 + 4', type: 'slashing' }],
      attackBonus: 8,
      attackType: 'melee',
      reach: 5,
    };
    const meleeUpdate = buildItemActivityUpdate('itemMelee', { aId: { type: 'attack' } }, meleeParsed);
    expect(meleeUpdate['system.activities.aId.range.reach']).toBe(5);
    expect(meleeUpdate['system.activities.aId.range.override']).toBe(true);

    // Save-only activity carrying range (Volenta Firebomb "within 30 feet").
    const saveParsed: ParsedAction = {
      damage: [{ formula: '2d6', type: 'fire' }],
      save: { dc: 14, ability: 'dex', onSuccess: 'half' },
      range: { normal: 30 },
    };
    const saveUpdate = buildItemActivityUpdate('itemSave', { sId: { type: 'save' } }, saveParsed);
    expect(saveUpdate['system.activities.sId.range.value']).toBe(30);
    expect(saveUpdate['system.activities.sId.range.override']).toBe(true);
  });

  it('writes versatile damage at item-level when parsed.versatile is set (Longsword two-handed)', () => {
    // Volenta Second Form Longsword: "9 (1d8+4) slashing, or 13 (2d10+4) slashing
    // if used with two hands". Primary damage rides the attack activity; the
    // versatile alternative goes on item-level system.damage.versatile so the
    // sheet exposes both damage rolls.
    const parsed: ParsedAction = {
      damage: [{ formula: '1d8 + 4', type: 'slashing' }],
      versatile: { formula: '2d10 + 4', type: 'slashing' },
      attackBonus: 8,
      attackType: 'melee',
      reach: 5,
    };
    const update = buildItemActivityUpdate('itemV', { aId: { type: 'attack' } }, parsed);

    // Primary on the attack activity
    expect(update['system.activities.aId.damage.parts']).toEqual([
      { custom: { enabled: true, formula: '1d8 + 4' }, types: ['slashing'] },
    ]);
    // Versatile at item level — custom-enabled with the literal Reloaded formula
    expect(update['system.damage.versatile.custom.enabled']).toBe(true);
    expect(update['system.damage.versatile.custom.formula']).toBe('2d10 + 4');
    expect(update['system.damage.versatile.types']).toEqual(['slashing']);
  });

  it('does NOT write versatile when parsed has only primary damage', () => {
    const parsed: ParsedAction = {
      damage: [{ formula: '2d4 + 4', type: 'piercing' }],
      attackBonus: 7,
      attackType: 'ranged',
      range: { normal: 15 },
    };
    const update = buildItemActivityUpdate('itemNoV', { aId: { type: 'attack' } }, parsed);
    expect(update['system.damage.versatile.custom.enabled']).toBeUndefined();
    expect(update['system.damage.versatile.custom.formula']).toBeUndefined();
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

describe('selectPruneCandidates (Phase 3b extension)', () => {
  // Volenta Reloaded keep-set: traits like "Sunlight Hypersensitivity" and
  // "Misty Escape" plus actions "Multiattack", "Hail of Daggers", "Dagger",
  // "Tanglefoot", "Thunderstone", "Smokestick", "Firebomb".
  const VOLENTA_RELOADED = [
    'Sunlight Hypersensitivity', 'Misty Escape', 'Spider Climb', 'Regeneration',
    'Multiattack', 'Hail of Daggers', 'Dagger', 'Tanglefoot', 'Thunderstone',
    'Smokestick', 'Firebomb',
  ];

  it('keeps non-prune-eligible types unconditionally (spells, equipment, classes — but NOT weapons)', () => {
    // dnd5e NPC attacks are type=weapon, so weapon must be in the prune-eligible
    // set. Spells/equipment/etc. stay protected.
    const items = [
      { id: 'a', name: 'Spell of Some Kind', type: 'spell' },
      { id: 'b', name: 'Backpack', type: 'equipment' },
      { id: 'c', name: 'Some Class', type: 'class' },
      { id: 'd', name: 'Some Race', type: 'race' },
      { id: 'e', name: 'Loot', type: 'loot' },
      { id: 'f', name: 'Container', type: 'container' },
    ];
    const { toPrune, decisions } = selectPruneCandidates(items, VOLENTA_RELOADED);
    expect(toPrune).toHaveLength(0);
    expect(decisions.every(d => d.decision === 'keep' && d.reason.startsWith('type='))).toBe(true);
  });

  it('keeps items added by us (flags.foundry-forge-mcp.source)', () => {
    const items = [
      { id: 'a', name: 'Reloaded-Only Trait', type: 'feat',
        flags: { 'foundry-forge-mcp': { source: 'reloaded-trait' } } },
      { id: 'b', name: 'Copy-patched Action', type: 'feat',
        flags: { 'foundry-forge-mcp': { source: 'reloaded-copy-patch' } } },
    ];
    const { toPrune, decisions } = selectPruneCandidates(items, VOLENTA_RELOADED);
    expect(toPrune).toHaveLength(0);
    expect(decisions.every(d => d.reason.startsWith('ours:'))).toBe(true);
  });

  it('keeps items in ALWAYS_KEEP (Multiattack, Spellcasting, Legendary Resistance, Sunlight Sensitivity)', () => {
    const items = [
      { id: 'a', name: 'Multiattack', type: 'feat' },
      { id: 'b', name: 'Spellcasting', type: 'feat' },
      { id: 'c', name: 'Legendary Resistance (3/Day)', type: 'feat' },
      { id: 'd', name: 'Sunlight Sensitivity', type: 'feat' },
      // Reloaded usually preserves vampire-family traits even after rename;
      // ALWAYS_KEEP covers the most common ones so they survive even when
      // Reloaded's rename has zero token overlap with the SRD name.
      { id: 'e', name: 'Vampire Weaknesses', type: 'feat' },
      { id: 'f', name: 'Misty Escape', type: 'feat' },
    ];
    const { toPrune } = selectPruneCandidates(items, []); // empty Reloaded
    expect(toPrune).toHaveLength(0);
  });

  it('keeps feats AND weapons whose name has token overlap with a Reloaded trait/action', () => {
    const items = [
      // Both shapes — feat and weapon — when name tokens overlap Reloaded.
      // "Hail of Daggers" → {hail, daggers} ∩ Reloaded {..., daggers, ...} = match on "daggers".
      { id: 'a', name: 'Hail of Daggers', type: 'weapon' },
      // SRD "Dagger Throw" not explicit in Reloaded, but token "dagger" matches Reloaded "Dagger".
      { id: 'b', name: 'Dagger Throw', type: 'feat' },
    ];
    const { toPrune, decisions } = selectPruneCandidates(items, VOLENTA_RELOADED);
    expect(toPrune).toHaveLength(0);
    const reasons = decisions.map(d => d.reason);
    expect(reasons.every(r => r.startsWith('token-match:'))).toBe(true);
  });

  it('prunes compendium-base weapons AND feats with no Reloaded match (Bite, Claws on Volenta)', () => {
    // Real Volenta-shape input: Vampire Spawn base ships Bite + Claws as type=weapon
    // (dnd5e 5.x NPC attacks are weapons, not feats). Reloaded Volenta has Hail of
    // Daggers + Dagger instead. Pruning must reach into type=weapon to delete the
    // compendium leftovers.
    const items = [
      { id: 'a', name: 'Bite', type: 'weapon' },                       // compendium leftover
      { id: 'b', name: 'Claws', type: 'weapon' },                      // compendium leftover
      { id: 'c', name: 'Multiattack', type: 'feat' },                  // ALWAYS_KEEP
      { id: 'd', name: 'Hail of Daggers', type: 'weapon' },            // token-match on "daggers"
      { id: 'e', name: 'Dagger', type: 'weapon' },                     // token-match on "dagger"
      { id: 'f', name: 'Vampire Weaknesses', type: 'feat' },           // ALWAYS_KEEP
    ];
    const { toPrune } = selectPruneCandidates(items, VOLENTA_RELOADED);
    expect(toPrune.map(p => p.name).sort()).toEqual(['Bite', 'Claws']);
    for (const p of toPrune) expect(p.decision).toBe('prune');
  });

  it('caps deletions at PRUNE_HARD_CAP, surfaces overflow as candidatesOverCap', () => {
    const items: any[] = [];
    for (let i = 0; i < PRUNE_HARD_CAP + 3; i++) {
      items.push({ id: `id${i}`, name: `Orphan Feat ${i}`, type: 'feat' });
    }
    const { toPrune, cappedOver } = selectPruneCandidates(items, []); // nothing in Reloaded
    expect(toPrune).toHaveLength(PRUNE_HARD_CAP);
    expect(cappedOver).toHaveLength(3);
  });

  it('handles parenthetical usage suffixes via stem stripping ("Multiattack (1/Day)" honored as ALWAYS_KEEP)', () => {
    const items = [
      { id: 'a', name: 'Multiattack (1/Day)', type: 'feat' },
      { id: 'b', name: 'Legendary Resistance (3/Day)', type: 'feat' },
    ];
    const { toPrune } = selectPruneCandidates(items, []);
    expect(toPrune).toHaveLength(0);
  });

  it('skips items missing id or name (defensive)', () => {
    const items = [
      { name: 'No ID', type: 'feat' },
      { id: 'x', type: 'feat' }, // no name
      { id: 'y', name: '', type: 'feat' }, // empty name
    ];
    const { toPrune, decisions } = selectPruneCandidates(items, []);
    expect(toPrune).toHaveLength(0);
    expect(decisions).toHaveLength(0);
  });
});

describe('derivePBFromCR (PB fallback when Reloaded omits the printed line)', () => {
  // SRD table: CR 0-4 → +2, 5-8 → +3, 9-12 → +4, 13-16 → +5,
  // 17-20 → +6, 21-24 → +7, 25-28 → +8, 29-30 → +9.
  it('returns 2 for CR 0 through 4 (including fractional)', () => {
    expect(derivePBFromCR(0)).toBe(2);
    expect(derivePBFromCR(0.125)).toBe(2);
    expect(derivePBFromCR(0.25)).toBe(2);
    expect(derivePBFromCR(0.5)).toBe(2);
    expect(derivePBFromCR(1)).toBe(2);
    expect(derivePBFromCR(4)).toBe(2);
  });

  it('returns 3 for CR 5-8 (Volenta 2nd Form is CR 6 → +3 expected)', () => {
    expect(derivePBFromCR(5)).toBe(3);
    expect(derivePBFromCR(6)).toBe(3);
    expect(derivePBFromCR(8)).toBe(3);
  });

  it('returns 4 for CR 9-12, 5 for 13-16, all the way to 9 for CR 30', () => {
    expect(derivePBFromCR(9)).toBe(4);
    expect(derivePBFromCR(12)).toBe(4);
    expect(derivePBFromCR(13)).toBe(5);
    expect(derivePBFromCR(16)).toBe(5);
    expect(derivePBFromCR(17)).toBe(6);
    expect(derivePBFromCR(20)).toBe(6);
    expect(derivePBFromCR(21)).toBe(7);
    expect(derivePBFromCR(25)).toBe(8);
    expect(derivePBFromCR(29)).toBe(9);
    expect(derivePBFromCR(30)).toBe(9);
  });

  it('returns 0 for null CR so callers can short-circuit', () => {
    expect(derivePBFromCR(null)).toBe(0);
  });
});

describe('stripUsageSuffix (Phase 8 name normalization)', () => {
  it('strips per-day suffix and returns the count + period', () => {
    const r = stripUsageSuffix('Tanglefoot (1/day)');
    expect(r.stem).toBe('Tanglefoot');
    expect(r.marker).toEqual({ count: 1, period: 'day' });
  });

  it('handles 3/day, multiple counts', () => {
    expect(stripUsageSuffix('Innate Spell (3/day)')).toEqual({
      stem: 'Innate Spell',
      marker: { count: 3, period: 'day' },
    });
  });

  it('handles short rest and long rest periods (with space)', () => {
    expect(stripUsageSuffix('Power Attack (1/short rest)').marker).toEqual({
      count: 1, period: 'short-rest',
    });
    expect(stripUsageSuffix('Battle Cry (2/long rest)').marker).toEqual({
      count: 2, period: 'long-rest',
    });
  });

  it('handles recharge ranges', () => {
    expect(stripUsageSuffix('Fire Breath (Recharge 5-6)').marker).toEqual({
      recharge: [5, 6],
    });
    expect(stripUsageSuffix('Frightful Presence (Recharge 6)').marker).toEqual({
      recharge: [6, 6],
    });
  });

  it('is case-insensitive on the period word', () => {
    expect(stripUsageSuffix('Foo (1/Day)').marker).toEqual({ count: 1, period: 'day' });
    expect(stripUsageSuffix('Foo (1/DAY)').marker).toEqual({ count: 1, period: 'day' });
  });

  it('returns null marker for names without a usage suffix', () => {
    expect(stripUsageSuffix('Bite').marker).toBeNull();
    expect(stripUsageSuffix('Multiattack').marker).toBeNull();
  });

  it('does NOT strip parens that are not usage markers', () => {
    // e.g. trait name with a non-usage parenthetical — leave it alone
    expect(stripUsageSuffix('Saber (Magical)').marker).toBeNull();
    expect(stripUsageSuffix('Saber (Magical)').stem).toBe('Saber (Magical)');
  });

  it('handles empty input safely', () => {
    expect(stripUsageSuffix('')).toEqual({ stem: '', marker: null });
  });

  it('trims surrounding whitespace from the stem', () => {
    expect(stripUsageSuffix('Tanglefoot (1/day)  ').stem).toBe('Tanglefoot');
  });
});

describe('buildUsesPayload (Phase 8 dnd5e system.uses shape)', () => {
  it('returns null for null/undefined marker so callers can skip the write', () => {
    expect(buildUsesPayload(null)).toBeNull();
    expect(buildUsesPayload(undefined)).toBeNull();
  });

  it('builds a long-rest recovery for "day" period (1/day → max 1, recovery lr)', () => {
    expect(buildUsesPayload({ count: 1, period: 'day' })).toEqual({
      max: '1',
      value: 1,
      spent: 0,
      recovery: [{ period: 'lr', type: 'recoverAll' }],
    });
  });

  it('builds a short-rest recovery for "short-rest" period', () => {
    expect(buildUsesPayload({ count: 2, period: 'short-rest' })).toEqual({
      max: '2',
      value: 2,
      spent: 0,
      recovery: [{ period: 'sr', type: 'recoverAll' }],
    });
  });

  it('builds a recharge recovery with the lower bound as the formula', () => {
    expect(buildUsesPayload({ recharge: [5, 6] })).toEqual({
      max: '1',
      value: 1,
      spent: 0,
      recovery: [{ period: 'recharge', type: 'recoverAll', formula: '5' }],
    });
  });
});

describe('buildConditionEffect (Phase 10A)', () => {
  it('builds a Foundry ActiveEffect doc with statuses + transfer:false + DAE flags', () => {
    const eff = buildConditionEffect({ type: 'restrained' });
    expect(eff.name).toBe('Restrained');
    expect(eff.statuses).toEqual(['restrained']);
    expect(eff.transfer).toBe(false);
    expect(eff.disabled).toBe(false);
    expect(eff.type).toBe('base');
    // 16-char activity-style id
    expect(eff._id).toMatch(/^[A-Za-z0-9]{16}$/);
    // DAE config: stackable noneNameOnly, transfer mirrored, no specialDuration
    expect(eff.flags.dae.stackable).toBe('noneNameOnly');
    expect(eff.flags.dae.transfer).toBe(false);
    expect(eff.flags.dae.specialDuration).toEqual([]);
    // Midi: forceCEOff so CE doesn't shadow the native Foundry status
    expect(eff.flags['midi-qol'].forceCEOff).toBe(true);
    // No duration field when condition has no duration
    expect(eff.duration).toBeUndefined();
    // 10A.5 fix: scaffold fields the DDB Wolf Bite carries. Without these,
    // Foundry's createEmbeddedDocuments silently strips the effect during
    // item creation (verified live against SmokeTest-10A-v2 build).
    expect(eff.origin).toBeNull();
    expect(eff.sort).toBe(0);
    expect(eff.tint).toBe('#ffffff');
    expect(eff.description).toBe('');
    expect(eff.flags.core).toEqual({});
  });

  it('writes a duration block when condition has rounds + seconds', () => {
    const eff = buildConditionEffect({
      type: 'poisoned',
      duration: { rounds: 10, seconds: 60 },
    });
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

  it('writes specialDuration tag for end-of-next-turn conditions', () => {
    const eff = buildConditionEffect({
      type: 'stunned',
      duration: { rounds: 1, seconds: 6, specialDuration: 'turnEnd' },
    });
    expect(eff.flags.dae.specialDuration).toEqual(['turnEnd']);
    // duration.rounds still set so Times-Up has a fallback expiry signal even
    // if specialDuration handling differs across module versions.
    expect(eff.duration?.rounds).toBe(1);
  });

  it('uses a Foundry SVG icon for known conditions', () => {
    expect(buildConditionEffect({ type: 'prone' }).img).toBe('icons/svg/falling.svg');
    expect(buildConditionEffect({ type: 'blinded' }).img).toBe('icons/svg/blind.svg');
    expect(buildConditionEffect({ type: 'restrained' }).img).toBe('icons/svg/net.svg');
  });

  it('two effects for the same condition get distinct ids (random 16-char)', () => {
    const a = buildConditionEffect({ type: 'restrained' });
    const b = buildConditionEffect({ type: 'restrained' });
    expect(a._id).not.toBe(b._id);
  });
});

describe('buildActivityTarget (Phase 10A.7)', () => {
  it('returns null for parsed action with no targetShape', () => {
    expect(buildActivityTarget({ damage: [] })).toBeNull();
  });

  it('writes target.template for circle radius', () => {
    const t = buildActivityTarget({
      damage: [],
      targetShape: { template: { shape: 'circle', size: 10 } },
    });
    expect(t).toEqual({
      prompt: true,
      template: { type: 'circle', size: 10, units: 'ft' },
    });
  });

  it('writes target.template for line with width', () => {
    const t = buildActivityTarget({
      damage: [],
      targetShape: { template: { shape: 'line', size: 100, width: 5 } },
    });
    expect(t!.template).toEqual({ type: 'line', size: 100, units: 'ft', width: 5 });
  });

  it('writes target.affects with count + choice for "up to two creatures"', () => {
    const t = buildActivityTarget({
      damage: [],
      targetShape: { affects: { type: 'creature', count: 2, choice: true } },
    });
    expect(t).toEqual({
      prompt: true,
      affects: { type: 'creature', count: 2, choice: true },
    });
  });

  it('writes both template + affects when both are parsed (Tanglefoot pattern)', () => {
    const t = buildActivityTarget({
      damage: [],
      targetShape: {
        template: { shape: 'circle', size: 10 },
        affects: { type: 'creature', count: 2, choice: true },
      },
    });
    expect(t).toEqual({
      prompt: true,
      template: { type: 'circle', size: 10, units: 'ft' },
      affects: { type: 'creature', count: 2, choice: true },
    });
  });

  it('writes affects with no count for "each creature in area" pattern', () => {
    const t = buildActivityTarget({
      damage: [],
      targetShape: {
        template: { shape: 'cone', size: 60 },
        affects: { type: 'creature' },
      },
    });
    expect(t!.affects).toEqual({ type: 'creature' });
  });

  it('attack-style single-target writes affects only (no template)', () => {
    const t = buildActivityTarget({
      damage: [],
      attackBonus: 7,
      attackType: 'melee',
      targetShape: { affects: { type: 'creature', count: 1 } },
    });
    expect(t).toEqual({
      prompt: true,
      affects: { type: 'creature', count: 1 },
    });
    expect(t!.template).toBeUndefined();
  });
});
