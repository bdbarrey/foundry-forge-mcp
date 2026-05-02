import { describe, it, expect, vi } from 'vitest';
import { buildItemActivityUpdate, selectPruneCandidates, PRUNE_HARD_CAP, derivePBFromCR, stripUsageSuffix, buildUsesPayload, buildConditionEffect, buildActivityTarget, resolveTraitTemplate, TRAIT_TEMPLATES, batchEntryName, CreateActorTools } from './create-actor.js';
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
    // DAE config: stackable 'noneName' dedupes by effect NAME across any
    // source — required because Tanglefoot fires saves on multiple targets
    // and 'noneNameOnly' (same source) wasn't catching duplicate Restrained
    // applications on the same token (live-verified on Volenta build 2026-04-29).
    expect(eff.flags.dae.stackable).toBe('noneName');
    expect(eff.flags.dae.transfer).toBe(false);
    expect(eff.flags.dae.specialDuration).toEqual([]);
    // showIcon=false suppresses the effect's own icon so Foundry only
    // renders the status condition icon (toggled by statuses[]). Otherwise
    // both render → double icon on token.
    expect(eff.flags.dae.showIcon).toBe(false);
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

  it('uses dnd5e 5.x canonical condition icons so the AE icon merges with the native status icon (no double-render)', () => {
    // 2026-05-02 live-verified Volenta: in dnd5e 5.x, an AE with statuses[]
    // causes the system to render the canonical condition icon AND the AE's
    // own img — two icons on the token. Pointing img at the same canonical
    // path means both renders draw the same SVG so they visually merge.
    expect(buildConditionEffect({ type: 'prone' }).img).toBe('systems/dnd5e/icons/svg/statuses/prone.svg');
    expect(buildConditionEffect({ type: 'blinded' }).img).toBe('systems/dnd5e/icons/svg/statuses/blinded.svg');
    expect(buildConditionEffect({ type: 'restrained' }).img).toBe('systems/dnd5e/icons/svg/statuses/restrained.svg');
    expect(buildConditionEffect({ type: 'deafened' }).img).toBe('systems/dnd5e/icons/svg/statuses/deafened.svg');
  });

  it('two effects for the same condition get distinct ids (random 16-char)', () => {
    const a = buildConditionEffect({ type: 'restrained' });
    const b = buildConditionEffect({ type: 'restrained' });
    expect(a._id).not.toBe(b._id);
  });

  it('writes Midi OverTime flag when condition.repeatSave is set', () => {
    const eff = buildConditionEffect({
      type: 'restrained',
      repeatSave: { period: 'turnEnd', ability: 'str', dc: 14 },
    });
    // Effect carries an OverTime change with the right format
    const overTimeChange = eff.changes.find((c: any) => c.key === 'flags.midi-qol.OverTime');
    expect(overTimeChange).toBeDefined();
    expect(overTimeChange.mode).toBe(0);
    expect(overTimeChange.priority).toBe(20);
    expect(overTimeChange.value).toContain('turn=end');
    expect(overTimeChange.value).toContain('saveDC=14');
    expect(overTimeChange.value).toContain('saveAbility=str');
    expect(overTimeChange.value).toContain('saveRemove=true');
    expect(overTimeChange.value).toContain('label=Restrained');
    // No fixed duration — the save IS the expiry
    expect(eff.duration).toBeUndefined();
  });

  it('writes turn=start variant when repeatSave.period is turnStart', () => {
    const eff = buildConditionEffect({
      type: 'paralyzed',
      repeatSave: { period: 'turnStart', ability: 'wis', dc: 17 },
    });
    const overTimeChange = eff.changes.find((c: any) => c.key === 'flags.midi-qol.OverTime');
    expect(overTimeChange.value).toContain('turn=start');
    expect(overTimeChange.value).toContain('saveDC=17');
    expect(overTimeChange.value).toContain('saveAbility=wis');
  });

  it('preserves duration when both duration AND repeatSave are set (whichever fires first)', () => {
    // Edge case: prose like "for 1 minute. A target can repeat the save..."
    // — both expiry mechanisms exist; effect carries both. Foundry/Midi
    // expires whichever fires first.
    const eff = buildConditionEffect({
      type: 'frightened',
      duration: { rounds: 10, seconds: 60 },
      repeatSave: { period: 'turnEnd', ability: 'wis', dc: 15 },
    });
    expect(eff.duration?.rounds).toBe(10);
    const overTimeChange = eff.changes.find((c: any) => c.key === 'flags.midi-qol.OverTime');
    expect(overTimeChange).toBeDefined();
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

  it('writes template + affects with count+choice (Tanglefoot pattern)', () => {
    // Reloaded's "up to two creatures within 5 feet of one another" is a real
    // mechanical cap — keep affects.count even when a template is present.
    // The post-template target picker lets the player choose WHICH two
    // creatures inside the placed circle are actually affected.
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

describe('resolveTraitTemplate (Phase 10B)', () => {
  it('returns null for an unknown trait name (Awakened Bloodlust et al.)', () => {
    expect(resolveTraitTemplate('Awakened Bloodlust')).toBeNull();
    expect(resolveTraitTemplate('Fast Grappler')).toBeNull();
  });

  it('matches "Pack Tactics" canonical name (case-insensitive)', () => {
    expect(resolveTraitTemplate('Pack Tactics')?.name).toBe('Pack Tactics');
    expect(resolveTraitTemplate('pack tactics')?.name).toBe('Pack Tactics');
    expect(resolveTraitTemplate('PACK TACTICS')?.name).toBe('Pack Tactics');
  });

  it('Sunlight Sensitivity and Sunlight Hypersensitivity resolve to DIFFERENT templates', () => {
    // 2026-05-02 — split previously-unified alias. Hypersensitivity adds the
    // 20-radiant-damage tick that Sensitivity doesn't have; Volenta needs both.
    expect(resolveTraitTemplate('Sunlight Sensitivity')?.name).toBe('Sunlight Sensitivity');
    expect(resolveTraitTemplate('Sunlight Hypersensitivity')?.name).toBe('Sunlight Hypersensitivity');
    expect(resolveTraitTemplate('sunlight hypersensitivity')?.name).toBe('Sunlight Hypersensitivity');
  });

  it('matches Regeneration (case-insensitive) and routes to the regeneration kind', () => {
    expect(resolveTraitTemplate('Regeneration')?.name).toBe('Regeneration');
    expect(resolveTraitTemplate('regeneration')?.name).toBe('Regeneration');
  });

  it('matches Magic Resistance (case-insensitive)', () => {
    expect(resolveTraitTemplate('Magic Resistance')?.name).toBe('Magic Resistance');
    expect(resolveTraitTemplate('magic resistance')?.name).toBe('Magic Resistance');
  });

  it('Regeneration template builds the OverTime healing effect with parsed amount', () => {
    const tpl = resolveTraitTemplate('Regeneration')!;
    const built = tpl.build('Regeneration', 'Volenta regains 10 hit points at the start of her turn.');
    const eff = built.effects[0];
    expect(eff.transfer).toBe(true);
    expect(eff.disabled).toBe(false);
    expect(eff.changes).toHaveLength(1);
    expect(eff.changes[0].key).toBe('flags.midi-qol.OverTime.regeneration');
    expect(eff.changes[0].value).toContain('damageRoll=10');
    expect(eff.changes[0].value).toContain('damageType=healing');
    // 2026-05-02 user feedback: "would only fire if she wasnt at max HP"
    expect(eff.changes[0].value).toContain('@attributes.hp.value<@attributes.hp.max');
  });

  it('Sunlight Hypersensitivity template includes BOTH disadvantage flags AND OverTime damage', () => {
    const tpl = resolveTraitTemplate('Sunlight Hypersensitivity')!;
    const built = tpl.build('Sunlight Hypersensitivity', 'It takes 20 radiant damage at the start of its turn.');
    const eff = built.effects[0];
    expect(eff.disabled).toBe(true); // GM-toggled
    const keys = eff.changes.map((c: any) => c.key).sort();
    expect(keys).toEqual([
      'flags.midi-qol.OverTime.sunlightHypersensitivity',
      'flags.midi-qol.disadvantage.ability.check.all',
      'flags.midi-qol.disadvantage.attack.all',
    ]);
  });

  it('Magic Resistance template emits the magicResistance.all flag', () => {
    const tpl = resolveTraitTemplate('Magic Resistance')!;
    const built = tpl.build('Magic Resistance', 'desc');
    const eff = built.effects[0];
    expect(eff.disabled).toBe(false);
    expect(eff.changes[0].key).toBe('flags.midi-qol.magicResistance.all');
  });

  it('Pack Tactics builds an effect with the load-bearing key + value (the DDB-broken bit)', () => {
    const tpl = resolveTraitTemplate('Pack Tactics')!;
    const built = tpl.build('Pack Tactics', 'desc');
    const eff = built.effects[0];
    expect(eff.transfer).toBe(true);
    expect(eff.disabled).toBe(false);
    expect(eff.changes).toHaveLength(1);
    // CRITICAL: key MUST be set (DDB-importer omits it, causing the
    // effect to apply indiscriminately as "always advantage on attacks").
    expect(eff.changes[0].key).toBe('flags.midi-qol.advantage.attack.all');
    expect(eff.changes[0].value).toContain('findNearby');
    expect(eff.changes[0].value).toContain('targetUuid');
    expect(eff.changes[0].mode).toBe(0); // CUSTOM
    expect(eff.statuses).toEqual([]);
    expect(eff.flags.dae.transfer).toBe(true);
  });

  it('Sunlight Sensitivity builds a DISABLED effect (GM toggles when in sunlight)', () => {
    const tpl = resolveTraitTemplate('Sunlight Sensitivity')!;
    const built = tpl.build('Sunlight Sensitivity', 'desc');
    const eff = built.effects[0];
    expect(eff.transfer).toBe(true);
    // disabled by default — GM enables when creature enters sunlight
    expect(eff.disabled).toBe(true);
    // Two flag changes: disadvantage on attack AND on ability checks
    const keys = eff.changes.map((c: any) => c.key).sort();
    expect(keys).toEqual([
      'flags.midi-qol.disadvantage.ability.check.all',
      'flags.midi-qol.disadvantage.attack.all',
    ]);
  });

  it('every registered template carries the canonical structural fields (so Foundry doesn\'t strip on create)', () => {
    for (const tpl of TRAIT_TEMPLATES) {
      const built = tpl.build(tpl.name, 'desc');
      expect(built.effects).toBeDefined();
      for (const eff of built.effects) {
        expect(eff._id).toMatch(/^[A-Za-z0-9]{16}$/);
        expect(eff.type).toBe('base');
        expect(eff.system).toEqual({});
        expect(eff.origin).toBeNull();
        expect(eff.tint).toBe('#ffffff');
        expect(eff.flags?.dae).toBeDefined();
        expect(eff.flags?.['midi-qol']).toBeDefined();
        expect(eff.flags?.core).toEqual({});
      }
    }
  });
});

// ----- Phase 12.1.3 — batch tool ------------------------------------------

describe('batchEntryName', () => {
  it('prefers actor_intent.name (Mode E)', () => {
    expect(batchEntryName({ actor_intent: { name: 'Volenta' } }, 0)).toBe('Volenta');
    // actor_intent.name wins even when other fields are present
    expect(
      batchEntryName(
        { actor_intent: { name: 'Volenta' }, creature_name: 'X', actor_name: 'Y' },
        0,
      ),
    ).toBe('Volenta');
  });

  it('falls through to creature_name (Mode A/B)', () => {
    expect(batchEntryName({ creature_name: 'Wight Commander' }, 0)).toBe(
      'Wight Commander',
    );
  });

  it('falls through to actor_name (Mode C rename)', () => {
    expect(batchEntryName({ actor_name: 'Renamed' }, 0)).toBe('Renamed');
  });

  it('reports compendium_base.itemId when no name fields are present', () => {
    expect(batchEntryName({ compendium_base: { packId: 'p', itemId: 'foo' } }, 0)).toBe(
      '<base:foo>',
    );
  });

  it('extracts h2 from reloaded_source markdown', () => {
    expect(
      batchEntryName(
        { reloaded_source: '<div class="statblock"><h2>Wolf Spawn</h2>...</div>' },
        0,
      ),
    ).toBe('Wolf Spawn');
  });

  it('falls back to <entry N> when nothing matches', () => {
    expect(batchEntryName({}, 7)).toBe('<entry 7>');
    expect(batchEntryName(null, 0)).toBe('<entry 0>');
    expect(batchEntryName(undefined, 3)).toBe('<entry 3>');
  });
});

describe('handleCreateActorsBatch', () => {
  // Stub deps — handleCreateActor is mocked, so foundryClient never actually
  // gets called.
  function makeTool() {
    const fakeLogger: any = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    // CreateActorTools' constructor calls logger.child({...}); mirror the
    // structured-logger interface by returning self.
    fakeLogger.child = () => fakeLogger;
    const fakeFoundry = { query: vi.fn() } as any;
    return new CreateActorTools({
      foundryClient: fakeFoundry,
      logger: fakeLogger,
    });
  }

  it('runs entries sequentially, reports per-entry success + actorId', async () => {
    const tool = makeTool();
    const calls: string[] = [];
    vi.spyOn(tool, 'handleCreateActor').mockImplementation(async (args: any) => {
      calls.push(args.creature_name);
      return { success: true, actorId: `actor-${args.creature_name}` };
    });

    const result = await tool.handleCreateActorsBatch({
      actors: [
        { creature_name: 'Alpha' },
        { creature_name: 'Beta' },
        { creature_name: 'Gamma' },
      ],
    });

    expect(calls).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toMatchObject({
      index: 0,
      name: 'Alpha',
      success: true,
      actorId: 'actor-Alpha',
    });
    expect(result.results[2]).toMatchObject({ name: 'Gamma', actorId: 'actor-Gamma' });
  });

  it('isolates per-entry failures and continues the batch', async () => {
    const tool = makeTool();
    vi.spyOn(tool, 'handleCreateActor').mockImplementation(async (args: any) => {
      if (args.creature_name === 'BrokenBeta') throw new Error('parse failed');
      return { success: true, actorId: `id-${args.creature_name}` };
    });

    const result = await tool.handleCreateActorsBatch({
      actors: [
        { creature_name: 'Alpha' },
        { creature_name: 'BrokenBeta' },
        { creature_name: 'Gamma' },
      ],
    });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[0]).toMatchObject({ success: true, actorId: 'id-Alpha' });
    expect(result.results[1]).toMatchObject({ success: false, error: 'parse failed' });
    expect(result.results[2]).toMatchObject({ success: true, actorId: 'id-Gamma' });
  });

  it('extracts names per entry using actor_intent / creature_name fallback chain', async () => {
    const tool = makeTool();
    vi.spyOn(tool, 'handleCreateActor').mockImplementation(async () => ({
      success: true,
      actorId: 'X',
    }));

    const result = await tool.handleCreateActorsBatch({
      actors: [
        { actor_intent: { name: 'IntentBuild' } },
        { creature_name: 'ParseBuild' },
        { compendium_base: { packId: 'p', itemId: 'baseId' } },
        {},
      ],
    });

    expect(result.results.map((r: any) => r.name)).toEqual([
      'IntentBuild',
      'ParseBuild',
      '<base:baseId>',
      '<entry 3>',
    ]);
  });

  it('rejects an empty actors array', async () => {
    const tool = makeTool();
    await expect(tool.handleCreateActorsBatch({ actors: [] })).rejects.toThrow();
    await expect(tool.handleCreateActorsBatch({ actors: undefined })).rejects.toThrow();
  });
});

// Phase 12.1.2 fix (2026-05-02) — Mode E minimal-intent passthrough.
// Bug: actor_intent: { name, base } only → adapter synthesizes sb with default
// HP 1 / AC 10 / abilities 10 / walk 0 → buildCoreNumericsChunk writes those
// defaults to the actor → spawned compendium base's stats clobbered.
// Fix: ActorIntentMask flags which blocks the intent supplied; chunk-builder
// skips a block when the mask says false, so adapter defaults stay inert.
describe('buildCoreNumericsChunk — Mode E mask gates default-overwrites', () => {
  function makeTool() {
    const fakeLogger: any = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    fakeLogger.child = () => fakeLogger;
    return new CreateActorTools({
      foundryClient: { query: vi.fn() } as any,
      logger: fakeLogger,
    });
  }

  // Hand-crafted sb mirrors what actorIntentToReloadedStatblock emits for a
  // name-only intent — keeps this test free of cross-module coupling.
  function defaultSb() {
    return {
      name: 'X', size: 'Medium', type: 'Humanoid', subtype: null, alignment: '',
      ac: 10, acNote: null,
      hp: { avg: 1, formula: null },
      speedText: '', speed: { walk: 0 },
      abilities: {
        str: { score: 10, mod: 0 }, dex: { score: 10, mod: 0 },
        con: { score: 10, mod: 0 }, int: { score: 10, mod: 0 },
        wis: { score: 10, mod: 0 }, cha: { score: 10, mod: 0 },
      },
      saves: {}, skills: {},
      damageResistances: null, damageImmunities: null,
      damageVulnerabilities: null, conditionImmunities: null,
      sensesText: '', passivePerception: null,
      languages: '', challenge: '', challengeNumeric: null, proficiencyBonus: null,
      traits: [], actions: [], bonusActions: [], reactions: [],
      legendaryActions: [], lairActions: [],
    };
  }

  it('Mode A (mask=null): writes every fundamental, current behavior preserved', () => {
    const tool: any = makeTool();
    const out = tool.buildCoreNumericsChunk(defaultSb(), null);
    expect(out['system.attributes.hp.max']).toBe(1);
    expect(out['system.attributes.ac.flat']).toBe(10);
    expect(out['system.attributes.movement.walk']).toBe(0);
    expect(out['system.abilities.str.value']).toBe(10);
    expect(out['system.abilities.cha.value']).toBe(10);
  });

  it('Mode E all-false mask: writes NO HP/AC/speed/abilities (the D-00-01 fix)', () => {
    const tool: any = makeTool();
    const out = tool.buildCoreNumericsChunk(defaultSb(), {
      hp: false, ac: false, speed: false, abilities: false,
    });
    expect(out['system.attributes.hp.max']).toBeUndefined();
    expect(out['system.attributes.hp.value']).toBeUndefined();
    expect(out['system.attributes.ac.flat']).toBeUndefined();
    expect(out['system.attributes.ac.calc']).toBeUndefined();
    expect(out['system.attributes.movement.walk']).toBeUndefined();
    expect(out['system.abilities.str.value']).toBeUndefined();
    expect(out['system.abilities.wis.value']).toBeUndefined();
  });

  it('Mode E partial mask: writes only the blocks the mask says true', () => {
    const tool: any = makeTool();
    const sb = { ...defaultSb(), hp: { avg: 50, formula: '8d10' }, ac: 17 };
    const out = tool.buildCoreNumericsChunk(sb, {
      hp: true, ac: false, speed: false, abilities: false,
    });
    // HP block written (mask.hp = true)
    expect(out['system.attributes.hp.max']).toBe(50);
    expect(out['system.attributes.hp.value']).toBe(50);
    expect(out['system.attributes.hp.formula']).toBe('8d10');
    // Other blocks skipped
    expect(out['system.attributes.ac.flat']).toBeUndefined();
    expect(out['system.attributes.movement.walk']).toBeUndefined();
    expect(out['system.abilities.str.value']).toBeUndefined();
  });

  it('Mode E mask still lets cr/alignment write (those are not in the mask scope)', () => {
    const tool: any = makeTool();
    const sb = { ...defaultSb(), challengeNumeric: 5, alignment: 'Neutral Evil' };
    const out = tool.buildCoreNumericsChunk(sb, {
      hp: false, ac: false, speed: false, abilities: false,
    });
    // cr/alignment write regardless of mask — the mask only gates HP/AC/speed/abilities
    expect(out['system.details.cr']).toBe(5);
    expect(out['system.details.alignment']).toBe('Neutral Evil');
  });
});
