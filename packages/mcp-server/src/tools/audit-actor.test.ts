import { describe, it, expect, vi } from 'vitest';
import { compareActor, ActorSnapshot, classifyIconUrl, checkPortraitCanonMatch } from './audit-actor.js';
import * as featIcons from './feat-icons.js';
import type { ReloadedStatblock } from '../parsers/reloaded-statblock.js';

// Minimal-shape helpers — tests construct only the fields each compare function reads.
function makeStatblock(overrides: Partial<ReloadedStatblock> = {}): ReloadedStatblock {
  return {
    name: 'Test Creature',
    size: 'Medium',
    type: 'Undead',
    subtype: null,
    alignment: 'neutral evil',
    ac: 14,
    acNote: null,
    hp: { avg: 100, formula: '12d8 + 36' },
    speedText: '30 ft.',
    speed: { walk: 30 },
    abilities: {
      str: { score: 16, mod: 3 }, dex: { score: 14, mod: 2 }, con: { score: 16, mod: 3 },
      int: { score: 10, mod: 0 }, wis: { score: 12, mod: 1 }, cha: { score: 12, mod: 1 },
    },
    saves: { str: 5, con: 5 },
    skills: {},
    damageResistances: null,
    damageImmunities: null,
    damageVulnerabilities: null,
    conditionImmunities: null,
    sensesText: 'Darkvision 60 ft., passive Perception 11',
    passivePerception: 11,
    languages: 'Common',
    challenge: '5',
    challengeNumeric: 5,
    proficiencyBonus: 3,
    traits: [],
    actions: [],
    bonusActions: [],
    reactions: [],
    legendaryActions: [],
    lairActions: [],
    ...overrides,
  };
}

function makeActor(system: any, items: any[] = []): ActorSnapshot {
  return { id: 'actor1', name: 'Test', system, items };
}

describe('compareActor — core numerics', () => {
  it('flags HP divergence as critical', () => {
    const sb = makeStatblock({ hp: { avg: 142, formula: null } });
    const actor = makeActor({ attributes: { hp: { max: 100, value: 100 }, ac: { flat: 14 } },
      abilities: { str: { value: 16 }, dex: { value: 14 }, con: { value: 16 },
        int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 } } });
    const audit = compareActor(actor, sb);
    const hp = audit.stats.find(d => d.field === 'hp.max');
    expect(hp).toBeDefined();
    expect(hp!.status).toBe('divergence');
    expect(hp!.severity).toBe('critical');
    expect(hp!.reloaded).toBe(142);
    expect(hp!.foundry).toBe(100);
  });

  it('matches AC when actor.flat equals reloaded ac', () => {
    const sb = makeStatblock({ ac: 17 });
    const actor = makeActor({ attributes: { hp: { max: 100 }, ac: { flat: 17, value: 17 } },
      abilities: { str: { value: 16 }, dex: { value: 14 }, con: { value: 16 },
        int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 } } });
    const audit = compareActor(actor, sb);
    const ac = audit.stats.find(d => d.field === 'ac');
    expect(ac!.status).toBe('match');
    expect(ac!.severity).toBe('critical');
  });

  it('flags ability score divergence as critical', () => {
    const sb = makeStatblock({
      abilities: {
        str: { score: 18, mod: 4 }, dex: { score: 14, mod: 2 }, con: { score: 16, mod: 3 },
        int: { score: 10, mod: 0 }, wis: { score: 12, mod: 1 }, cha: { score: 12, mod: 1 },
      },
    });
    const actor = makeActor({ attributes: { hp: { max: 100 }, ac: { flat: 14 } },
      abilities: { str: { value: 16 } /* wrong */, dex: { value: 14 }, con: { value: 16 },
        int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 } } });
    const audit = compareActor(actor, sb);
    const str = audit.stats.find(d => d.field === 'abilities.str');
    expect(str!.status).toBe('divergence');
    expect(str!.severity).toBe('critical');
  });

  it('flags alignment divergence as low', () => {
    const sb = makeStatblock({ alignment: 'chaotic evil' });
    const actor = makeActor({ attributes: { hp: { max: 100 }, ac: { flat: 14 } },
      abilities: { str: { value: 16 }, dex: { value: 14 }, con: { value: 16 },
        int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 } },
      details: { alignment: 'neutral evil' } });
    const audit = compareActor(actor, sb);
    const align = audit.stats.find(d => d.field === 'alignment');
    expect(align!.status).toBe('divergence');
    expect(align!.severity).toBe('low');
  });
});

describe('compareActor — saves', () => {
  it('flags missing save proficiency as critical', () => {
    const sb = makeStatblock({ saves: { dex: 5, con: 6 } });
    const actor = makeActor({ attributes: {}, abilities: {
      str: { value: 16 }, dex: { value: 14, proficient: 0 }, con: { value: 16, proficient: 1 },
      int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 },
    } });
    const audit = compareActor(actor, sb);
    const dexSave = audit.saves.find(d => d.field === 'saves.dex.proficient');
    const conSave = audit.saves.find(d => d.field === 'saves.con.proficient');
    expect(dexSave!.status).toBe('divergence');
    expect(dexSave!.severity).toBe('critical');
    expect(conSave!.status).toBe('match');
  });
});

describe('compareActor — skills', () => {
  it('infers expertise level and flags wrong proficient setting', () => {
    // Volenta-shape: Acrobatics +10 with Dex 18 (mod +4) and prof +3 should infer expertise (level=2).
    const sb = makeStatblock({
      abilities: {
        str: { score: 16, mod: 3 }, dex: { score: 18, mod: 4 }, con: { score: 16, mod: 3 },
        int: { score: 10, mod: 0 }, wis: { score: 12, mod: 1 }, cha: { score: 12, mod: 1 },
      },
      proficiencyBonus: 3,
      skills: { acrobatics: 10 },
    });
    const actor = makeActor({
      attributes: { prof: 3 },
      abilities: { dex: { value: 18 } },
      skills: { acr: { proficient: 1 } /* basic prof, not expertise */ },
    });
    const audit = compareActor(actor, sb);
    const acr = audit.skills.find(d => d.field === 'skills.acr');
    expect(acr).toBeDefined();
    expect((acr!.reloaded as any).expectedLevel).toBe(2);
    expect(acr!.status).toBe('divergence');
    expect(acr!.severity).toBe('medium');
  });

  it('matches basic-prof skill level', () => {
    // Perception +5 with Wis 14 (+2) and prof +3 → basic prof (1).
    const sb = makeStatblock({
      abilities: {
        str: { score: 16, mod: 3 }, dex: { score: 14, mod: 2 }, con: { score: 16, mod: 3 },
        int: { score: 10, mod: 0 }, wis: { score: 14, mod: 2 }, cha: { score: 12, mod: 1 },
      },
      proficiencyBonus: 3,
      skills: { perception: 5 },
    });
    const actor = makeActor({
      attributes: { prof: 3 },
      abilities: { wis: { value: 14 } },
      skills: { prc: { proficient: 1 } },
    });
    const audit = compareActor(actor, sb);
    const prc = audit.skills.find(d => d.field === 'skills.prc');
    expect((prc!.reloaded as any).expectedLevel).toBe(1);
    expect(prc!.status).toBe('match');
  });
});

describe('compareActor — features (item-level traits)', () => {
  it('reports trait missing from actor', () => {
    const sb = makeStatblock({
      traits: [
        { name: 'Sunlight Hypersensitivity', description: 'foo', parsed: { damage: [] } },
      ],
    });
    const actor = makeActor({ attributes: {}, abilities: {} },
      [{ name: 'Spider Climb', type: 'feat' }]);
    const audit = compareActor(actor, sb);
    expect(audit.features.missingFromActor).toContain('Sunlight Hypersensitivity');
  });

  it('does not report extra items that were added by create-actor (flagged source)', () => {
    const sb = makeStatblock();
    const actor = makeActor({ attributes: {}, abilities: {} }, [
      { name: 'Custom Reloaded Trait', type: 'feat',
        flags: { 'foundry-forge-mcp': { source: 'reloaded-hybrid' } } },
      { name: 'Vampire Weaknesses', type: 'feat' },
    ]);
    const audit = compareActor(actor, sb);
    expect(audit.features.extraOnActor).not.toContain('Custom Reloaded Trait');
    expect(audit.features.extraOnActor).toContain('Vampire Weaknesses');
  });

  it('skips Multiattack as an "extra"', () => {
    const sb = makeStatblock();
    const actor = makeActor({ attributes: {}, abilities: {} },
      [{ name: 'Multiattack', type: 'feat' }]);
    const audit = compareActor(actor, sb);
    expect(audit.features.extraOnActor).not.toContain('Multiattack');
  });
});

describe('compareActor — actions', () => {
  it('flags missing action item as critical', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Hail of Daggers',
        description: 'flings daggers',
        parsed: { damage: [{ formula: '2d4+4', type: 'piercing' }], attackBonus: 7, attackType: 'ranged', range: { normal: 15 } },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, []);
    const audit = compareActor(actor, sb);
    const ha = audit.actions.find(a => a.name === 'Hail of Daggers');
    expect(ha!.status).toBe('missing-item');
    // The summary should count missing actions as critical.
    expect(audit.summary.criticalDivergences).toBeGreaterThanOrEqual(1);
  });

  it('flags wrong attack bonus as critical', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Dagger',
        description: 'stab',
        parsed: { damage: [{ formula: '1d4+4', type: 'piercing' }], attackBonus: 7, attackType: 'melee', reach: 5 },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Dagger', type: 'weapon', system: {
        activities: {
          atk1: {
            type: 'attack',
            attack: { bonus: '+5', flat: true, type: { value: 'melee' } },
            range: { reach: 5, units: 'ft' },
            damage: { parts: [{ custom: { enabled: true, formula: '1d4+4' }, types: ['piercing'] }], includeBase: false },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const dagger = audit.actions.find(a => a.name === 'Dagger');
    const bonus = dagger!.divergences.find(d => d.field === 'attack.bonus');
    expect(bonus).toBeDefined();
    expect(bonus!.severity).toBe('critical');
    expect(bonus!.foundry).toBe(5);
    expect(bonus!.reloaded).toBe(7);
  });

  it('flags damage.includeBase!=false as critical (Hail of Daggers shape)', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Hail of Daggers',
        description: 'volley',
        parsed: { damage: [{ formula: '2d4+4', type: 'piercing' }], attackBonus: 7, attackType: 'ranged', range: { normal: 15 } },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Hail of Daggers', type: 'weapon', system: {
        activities: {
          atk1: {
            type: 'attack',
            attack: { bonus: '+7', flat: true, type: { value: 'ranged' } },
            range: { value: 15, units: 'ft' },
            damage: {
              parts: [{ custom: { enabled: true, formula: '2d4+4' }, types: ['piercing'] }],
              // includeBase: undefined (i.e. not explicitly false) → critical
            },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const hod = audit.actions.find(a => a.name === 'Hail of Daggers');
    const includeBase = hod!.divergences.find(d => d.field === 'damage.includeBase');
    expect(includeBase).toBeDefined();
    expect(includeBase!.severity).toBe('critical');
  });

  it('flags wrong save DC as critical', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Firebomb',
        description: 'boom',
        parsed: { damage: [{ formula: '2d6', type: 'fire' }], save: { dc: 14, ability: 'dex', onSuccess: 'half' }, range: { normal: 30 } },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Firebomb', type: 'consumable', system: {
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['dex'], dc: { calculation: '', formula: '12' } },
            damage: { parts: [{ custom: { enabled: true, formula: '2d6' }, types: ['fire'] }], onSave: 'half' },
            range: { value: 30, units: 'ft' },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const fb = audit.actions.find(a => a.name === 'Firebomb');
    const dc = fb!.divergences.find(d => d.field === 'save.dc');
    expect(dc).toBeDefined();
    expect(dc!.severity).toBe('critical');
    expect(dc!.foundry).toBe(12);
    expect(dc!.reloaded).toBe(14);
  });

  it('matches save activity exactly when DC + ability + damage + description align', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Tanglefoot',
        description: 'A sticky bomb',
        parsed: { damage: [], save: { dc: 14, ability: 'str' } },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Tanglefoot', type: 'feat', system: {
        description: { value: '<p>A sticky bomb</p>' },
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['str'], dc: { calculation: '', formula: '14' } },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const tf = audit.actions.find(a => a.name === 'Tanglefoot');
    expect(tf!.status).toBe('match');
    expect(tf!.divergences).toEqual([]);
  });

  it('flags damage parts mismatch (formula or type) as critical', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Bite',
        description: 'chomp',
        parsed: { damage: [{ formula: '2d6+3', type: 'piercing' }], attackBonus: 6, attackType: 'melee', reach: 5 },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Bite', type: 'weapon', system: {
        activities: {
          atk1: {
            type: 'attack',
            attack: { bonus: '+6', flat: true, type: { value: 'melee' } },
            range: { reach: 5, units: 'ft' },
            damage: {
              parts: [{ custom: { enabled: true, formula: '1d6+3' }, types: ['piercing'] }], // wrong dice
              includeBase: false,
            },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const bite = audit.actions.find(a => a.name === 'Bite');
    const dmg = bite!.divergences.find(d => d.field === 'damage.parts');
    expect(dmg).toBeDefined();
    expect(dmg!.severity).toBe('critical');
  });
});

describe('compareActor — traits list (semicolon conditional clauses)', () => {
  it('does not flag conditional damage resistances as missing', () => {
    // Volenta-shape: "necrotic; bludgeoning, piercing, and slashing from nonmagical attacks"
    // create-actor only writes ['necrotic'] to .value (the second segment goes to .custom
    // because "from nonmagical attacks" is unrecognized). Audit must mirror that.
    const sb = makeStatblock({
      damageResistances: 'necrotic; bludgeoning, piercing, and slashing from nonmagical attacks',
    });
    const actor = makeActor({
      attributes: { hp: { max: 100 }, ac: { flat: 14 } },
      abilities: { str: { value: 16 }, dex: { value: 14 }, con: { value: 16 },
        int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 } },
      traits: { dr: { value: ['necrotic'] } },
    });
    const audit = compareActor(actor, sb);
    const dr = audit.traitsList.find(d => d.field === 'traits.dr');
    expect(dr!.status).toBe('match');
    expect(dr!.reloaded).toEqual(['necrotic']);
  });

  it('flags missing damage resistance from a fully-recognized segment', () => {
    const sb = makeStatblock({ damageResistances: 'fire, cold' });
    const actor = makeActor({
      attributes: { hp: { max: 100 }, ac: { flat: 14 } },
      abilities: { str: { value: 16 }, dex: { value: 14 }, con: { value: 16 },
        int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 } },
      traits: { dr: { value: ['fire'] } },
    });
    const audit = compareActor(actor, sb);
    const dr = audit.traitsList.find(d => d.field === 'traits.dr');
    expect(dr!.status).toBe('divergence');
    expect((dr!.note ?? '')).toContain('cold');
  });
});

describe('compareActor — versatile damage (Phase 3a-polish #2)', () => {
  function makeWithVersatileLongsword(versatileSystem: any | undefined): { sb: ReloadedStatblock; actor: ActorSnapshot } {
    const sb = makeStatblock({
      actions: [{
        name: 'Longsword',
        description: 'Melee Weapon Attack: +7 to hit, reach 5 ft., one target. Hit: 13 (2d8 + 4) slashing damage, or 15 (2d10 + 4) slashing damage if used with two hands.',
        parsed: {
          attackBonus: 7, attackType: 'melee', reach: 5,
          damage: [{ formula: '2d8 + 4', type: 'slashing' }],
          versatile: { formula: '2d10 + 4', type: 'slashing' },
        },
      }],
    });
    const actor = makeActor(
      { attributes: { hp: { max: 100 }, ac: { flat: 14 } },
        abilities: { str: { value: 16 }, dex: { value: 14 }, con: { value: 16 },
          int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 } } },
      [{
        id: 'longswordItemId',
        name: 'Longsword',
        type: 'weapon',
        system: {
          activities: { attackId: { type: 'attack', attack: { bonus: '+7', flat: true, type: { value: 'melee' } },
            range: { reach: 5, units: 'ft', override: true },
            damage: { parts: [{ types: ['slashing'], custom: { enabled: true, formula: '2d8 + 4' } }], includeBase: false } } },
          ...(versatileSystem !== undefined ? { damage: { versatile: versatileSystem } } : {}),
        },
      }],
    );
    return { sb, actor };
  }

  it('reports no versatile-related divergence when item.system.damage.versatile.custom matches parsed', () => {
    // compareSingleAction filters out matches, so a successful versatile write
    // should not surface in the action's divergences list. (Other unrelated
    // checks may still produce divergences for an action — we only assert on
    // the versatile fields.)
    const { sb, actor } = makeWithVersatileLongsword({
      number: 1, denomination: 10,
      types: ['slashing'],
      custom: { enabled: true, formula: '2d10 + 4' },
    });
    const audit = compareActor(actor, sb);
    const longsword = audit.actions.find(a => a.name === 'Longsword')!;
    expect(longsword.divergences.find(d => d.field?.startsWith('damage.versatile'))).toBeUndefined();
  });

  it('flags as divergence when versatile.custom.enabled is false (write didn\'t land)', () => {
    const { sb, actor } = makeWithVersatileLongsword({
      types: [], custom: { enabled: false },
    });
    const audit = compareActor(actor, sb);
    const longsword = audit.actions.find(a => a.name === 'Longsword')!;
    const versatile = longsword.divergences.find(d => d.field === 'damage.versatile');
    expect(versatile).toBeDefined();
    expect(versatile!.status).toBe('divergence');
    expect(versatile!.severity).toBe('medium');
    expect(versatile!.foundry).toBe('not-set');
  });

  it('flags as divergence when versatile is missing entirely from item.system.damage', () => {
    const { sb, actor } = makeWithVersatileLongsword(undefined);
    const audit = compareActor(actor, sb);
    const longsword = audit.actions.find(a => a.name === 'Longsword')!;
    const versatile = longsword.divergences.find(d => d.field === 'damage.versatile');
    expect(versatile).toBeDefined();
    expect(versatile!.status).toBe('divergence');
  });

  it('does not emit versatile checks when parsed has no versatile (Reloaded action without two-handed alt)', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Bite',
        description: 'Melee: +5 to hit, reach 5 ft., 6 (1d6+3) piercing damage.',
        parsed: { attackBonus: 5, attackType: 'melee', reach: 5,
          damage: [{ formula: '1d6 + 3', type: 'piercing' }] },
      }],
    });
    const actor = makeActor(
      { attributes: { hp: { max: 100 }, ac: { flat: 14 } },
        abilities: { str: { value: 16 }, dex: { value: 14 }, con: { value: 16 },
          int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 } } },
      [{ id: 'bite', name: 'Bite', type: 'weapon',
        system: { activities: { aId: { type: 'attack', attack: { bonus: '+5', flat: true },
          range: { reach: 5 }, damage: { parts: [{ types: ['piercing'], custom: { enabled: true, formula: '1d6 + 3' } }] } } } } }],
    );
    const audit = compareActor(actor, sb);
    const bite = audit.actions.find(a => a.name === 'Bite')!;
    expect(bite.divergences.find(d => d.field?.startsWith('damage.versatile'))).toBeUndefined();
  });
});

describe('compareActor — summary aggregation', () => {
  it('counts critical/medium/low correctly', () => {
    const sb = makeStatblock({ hp: { avg: 142, formula: null }, alignment: 'chaotic evil' });
    const actor = makeActor({
      attributes: { hp: { max: 100 }, ac: { flat: 14 } },
      abilities: { str: { value: 16 }, dex: { value: 14 }, con: { value: 16 },
        int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 } },
      details: { alignment: 'neutral evil' },
    });
    const audit = compareActor(actor, sb);
    expect(audit.summary.criticalDivergences).toBeGreaterThanOrEqual(1); // HP
    expect(audit.summary.lowDivergences).toBeGreaterThanOrEqual(1); // alignment
  });
});

describe('compareActor — Phase 10A save.condition link', () => {
  it('clean match: save.effects[] points at item.effects[] with the right status', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Tanglefoot',
        description: 'A sticky bomb',
        parsed: {
          damage: [],
          save: { dc: 14, ability: 'str' },
          condition: { type: 'restrained' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Tanglefoot', type: 'feat',
      system: {
        description: { value: '<p>A sticky bomb</p>' },
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['str'], dc: { calculation: '', formula: '14' } },
            effects: [{ _id: 'effrestrained1', level: { min: null, max: null }, onSave: false }],
          },
        },
      },
      effects: [{
        _id: 'effrestrained1',
        name: 'Restrained',
        statuses: ['restrained'],
        transfer: false,
      }],
    }]);
    const audit = compareActor(actor, sb);
    const tf = audit.actions.find(a => a.name === 'Tanglefoot')!;
    expect(tf.divergences.find(d => d.field === 'save.condition')).toBeUndefined();
  });

  it('flags missing link as medium with no-link foundry value', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Tanglefoot',
        description: 'A sticky bomb',
        parsed: {
          damage: [],
          save: { dc: 14, ability: 'str' },
          condition: { type: 'restrained' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Tanglefoot', type: 'feat',
      system: {
        description: { value: '<p>A sticky bomb</p>' },
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['str'], dc: { calculation: '', formula: '14' } },
            // no effects[] link — older builds before Phase 10A
          },
        },
      },
      // no item-side effects either
    }]);
    const audit = compareActor(actor, sb);
    const tf = audit.actions.find(a => a.name === 'Tanglefoot')!;
    const cond = tf.divergences.find(d => d.field === 'save.condition');
    expect(cond).toBeDefined();
    expect(cond!.severity).toBe('medium');
    // Refined diagnostic: foundry block now carries kind sentinel + the
    // item.effects field type so we can tell whether visibility is the
    // problem vs the data being genuinely absent.
    expect(cond!.foundry).toMatchObject({ kind: 'no-link-entry' });
    expect(cond!.note).toContain('did not attach a condition link');
  });

  it('inferred-link OK: activity has effects[] entry without _id (dnd5e toJSON quirk) AND item has matching-status effect → no divergence', () => {
    // dnd5e's Activity.effects toJSON strips _id from the readback. Even when
    // the link IS persisted at storage time (Foundry's Applied Effects panel
    // confirms it live), the audit can never see the strict link via this
    // serialization. Inferred match avoids a false-positive divergence.
    const sb = makeStatblock({
      actions: [{
        name: 'Tanglefoot',
        description: 'A sticky bomb',
        parsed: {
          damage: [],
          save: { dc: 14, ability: 'str' },
          condition: { type: 'restrained' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Tanglefoot', type: 'feat',
      system: {
        description: { value: '<p>A sticky bomb</p>' },
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['str'], dc: { calculation: '', formula: '14' } },
            // entry exists but no _id — dnd5e Activity.effects toJSON quirk
            effects: [{ level: { min: null, max: null }, onSave: false }],
          },
        },
      },
      // Item-side effect WAS persisted with the right status.
      effects: [{
        _id: 'effrestrained1',
        name: 'Restrained',
        statuses: ['restrained'],
        transfer: false,
      }],
    }]);
    const audit = compareActor(actor, sb);
    const tf = audit.actions.find(a => a.name === 'Tanglefoot')!;
    // No save.condition divergence — the inference path treats this as a soft match.
    expect(tf.divergences.find(d => d.field === 'save.condition')).toBeUndefined();
  });

  it('flags status-mismatch when link is present but the linked effect carries a different condition', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Tanglefoot',
        description: 'A sticky bomb',
        parsed: {
          damage: [],
          save: { dc: 14, ability: 'str' },
          condition: { type: 'restrained' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Tanglefoot', type: 'feat',
      system: {
        description: { value: '<p>A sticky bomb</p>' },
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['str'], dc: { calculation: '', formula: '14' } },
            effects: [{ _id: 'effwrong1', level: { min: null, max: null }, onSave: false }],
          },
        },
      },
      effects: [{
        _id: 'effwrong1',
        name: 'Prone',
        statuses: ['prone'], // wrong condition
        transfer: false,
      }],
    }]);
    const audit = compareActor(actor, sb);
    const tf = audit.actions.find(a => a.name === 'Tanglefoot')!;
    const cond = tf.divergences.find(d => d.field === 'save.condition');
    expect(cond).toBeDefined();
    expect(cond!.severity).toBe('medium');
    // Note distinguishes "no link" from "link present, wrong status".
    expect(cond!.note).toContain('linked effect(s) present');
    expect(cond!.note).toContain("statuses: ['restrained']");
    expect(cond!.foundry).toMatchObject({
      linkedEffects: [{ _id: 'effwrong1', statuses: ['prone'] }],
    });
  });

  it('does NOT add a save.condition divergence when parsed.condition is undefined', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Firebomb',
        description: 'pure damage save',
        parsed: {
          damage: [{ formula: '2d6', type: 'fire' }],
          save: { dc: 14, ability: 'dex', onSuccess: 'half' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Firebomb', type: 'consumable', system: {
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['dex'], dc: { calculation: '', formula: '14' } },
            damage: { parts: [{ custom: { enabled: true, formula: '2d6' }, types: ['fire'] }], onSave: 'half' },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const fb = audit.actions.find(a => a.name === 'Firebomb')!;
    expect(fb.divergences.find(d => d.field === 'save.condition')).toBeUndefined();
  });
});

describe('compareActor — Phase 10A.7 targeting rules', () => {
  it('flags missing target.template when parsed.targetShape.template is set', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Tanglefoot',
        description: 'AOE save',
        parsed: {
          damage: [],
          save: { dc: 14, ability: 'str' },
          targetShape: { template: { shape: 'circle', size: 10 }, affects: { type: 'creature' } },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Tanglefoot', type: 'feat', system: {
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['str'], dc: { calculation: '', formula: '14' } },
            // No target.template — this is what the rule should flag.
            target: { affects: { type: 'creature' } },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const tf = audit.actions.find(a => a.name === 'Tanglefoot')!;
    const tpl = tf.divergences.find(d => d.field === 'target.template');
    expect(tpl).toBeDefined();
    expect(tpl!.severity).toBe('medium');
    expect(tpl!.reloaded).toEqual({ type: 'circle', size: 10 });
    expect(tpl!.note).toContain("won't prompt for a Measured Template");
  });

  it('clean match when target.template matches parsed', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Tanglefoot',
        description: 'AOE save',
        parsed: {
          damage: [],
          save: { dc: 14, ability: 'str' },
          targetShape: { template: { shape: 'circle', size: 10 }, affects: { type: 'creature', count: 2, choice: true } },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Tanglefoot', type: 'feat', system: {
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['str'], dc: { calculation: '', formula: '14' } },
            target: {
              template: { type: 'circle', size: 10, units: 'ft' },
              affects: { type: 'creature', count: 2, choice: true },
            },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const tf = audit.actions.find(a => a.name === 'Tanglefoot')!;
    expect(tf.divergences.find(d => d.field === 'target.template')).toBeUndefined();
    expect(tf.divergences.find(d => d.field === 'target.affects')).toBeUndefined();
  });

  it('flags target.affects mismatch (parsed says count=2, actor has count=1)', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Tanglefoot',
        description: 'AOE save',
        parsed: {
          damage: [],
          save: { dc: 14, ability: 'str' },
          targetShape: { affects: { type: 'creature', count: 2 } },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Tanglefoot', type: 'feat', system: {
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['str'], dc: { calculation: '', formula: '14' } },
            target: { affects: { type: 'creature', count: 1 } },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const tf = audit.actions.find(a => a.name === 'Tanglefoot')!;
    const aff = tf.divergences.find(d => d.field === 'target.affects');
    expect(aff).toBeDefined();
    expect(aff!.severity).toBe('medium');
    expect(aff!.foundry).toMatchObject({ count: 1 });
    expect(aff!.reloaded).toMatchObject({ count: 2 });
  });
});

describe('compareActor — Phase 11.2 attack→save chain rule', () => {
  it('flags missing chain when item has both attack + save activities (Bite-style)', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Bite',
        description: 'attack with save-vs-prone',
        parsed: {
          damage: [{ formula: '1d8+2', type: 'piercing' }],
          attackBonus: 4,
          attackType: 'melee',
          reach: 5,
          save: { dc: 11, ability: 'str' },
          condition: { type: 'prone' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Bite', type: 'weapon', system: {
        activities: {
          atk1: {
            type: 'attack',
            _id: 'atk1',
            attack: { bonus: '+4', flat: true, type: { value: 'melee' } },
            damage: { parts: [{ custom: { enabled: true, formula: '1d8+2' }, types: ['piercing'] }], includeBase: false },
            range: { reach: 5, units: 'ft' },
            // No triggeredActivityId — this is what the rule flags.
          },
          sav1: {
            type: 'save',
            _id: 'sav1',
            save: { ability: ['str'], dc: { calculation: '', formula: '11' } },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const bite = audit.actions.find(a => a.name === 'Bite')!;
    const chain = bite.divergences.find(d => d.field === 'attack-save.chain');
    expect(chain).toBeDefined();
    expect(chain!.severity).toBe('medium');
    expect(chain!.note).toContain('triggeredActivityId');
    expect(chain!.reloaded).toMatchObject({ triggeredActivityId: 'sav1' });
  });

  it('clean match when attack.midiProperties.triggeredActivityId points at save activity', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Bite',
        description: 'attack with save-vs-prone',
        parsed: {
          damage: [{ formula: '1d8+2', type: 'piercing' }],
          attackBonus: 4,
          attackType: 'melee',
          reach: 5,
          save: { dc: 11, ability: 'str' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Bite', type: 'weapon', system: {
        activities: {
          atk1: {
            type: 'attack',
            _id: 'atk1',
            attack: { bonus: '+4', flat: true, type: { value: 'melee' } },
            damage: { parts: [{ custom: { enabled: true, formula: '1d8+2' }, types: ['piercing'] }], includeBase: false },
            range: { reach: 5, units: 'ft' },
            midiProperties: { triggeredActivityId: 'sav1' },
          },
          sav1: {
            type: 'save',
            _id: 'sav1',
            save: { ability: ['str'], dc: { calculation: '', formula: '11' } },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const bite = audit.actions.find(a => a.name === 'Bite')!;
    expect(bite.divergences.find(d => d.field === 'attack-save.chain')).toBeUndefined();
  });

  it('does NOT flag chain when item has only an attack (no save)', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Slash',
        description: 'attack only',
        parsed: {
          damage: [{ formula: '1d6+2', type: 'slashing' }],
          attackBonus: 4,
          attackType: 'melee',
          reach: 5,
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Slash', type: 'weapon', system: {
        activities: {
          atk1: {
            type: 'attack',
            _id: 'atk1',
            attack: { bonus: '+4', flat: true, type: { value: 'melee' } },
            damage: { parts: [{ custom: { enabled: true, formula: '1d6+2' }, types: ['slashing'] }], includeBase: false },
            range: { reach: 5, units: 'ft' },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const slash = audit.actions.find(a => a.name === 'Slash')!;
    expect(slash.divergences.find(d => d.field === 'attack-save.chain')).toBeUndefined();
  });

  // Regression: production Foundry serializes system.activities as
  // Record<id, body> where the body has no _id field — only the key
  // carries the id. Object.values() previously discarded the keys, so
  // saveAct._id was undefined and the chain check could never match
  // even when the actor was correctly wired. compareActor must inject
  // the key as _id when materializing the activity list.
  it('chain check passes when production-shape activities have no inline _id field', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Saber',
        description: 'attack with save-vs-prone',
        parsed: {
          damage: [{ formula: '1d8+6', type: 'slashing' }],
          attackBonus: 11,
          attackType: 'melee',
          reach: 5,
          save: { dc: 15, ability: 'str' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Saber', type: 'weapon', system: {
        activities: {
          // No inline _id — production data shape from Foundry
          atkProd: {
            type: 'attack',
            attack: { bonus: '+11', flat: true, type: { value: 'melee' } },
            damage: { parts: [{ custom: { enabled: true, formula: '1d8+6' }, types: ['slashing'] }], includeBase: false },
            range: { reach: 5, units: 'ft' },
            midiProperties: { triggeredActivityId: 'savProd' },
          },
          savProd: {
            type: 'save',
            save: { ability: ['str'], dc: { calculation: '', formula: '15' } },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const saber = audit.actions.find(a => a.name === 'Saber')!;
    expect(saber.divergences.find(d => d.field === 'attack-save.chain')).toBeUndefined();
  });
});

describe('classifyIconUrl — actor portrait probe (Arc H AAR 2026-05-17)', () => {
  // Phase 2 (gap-closure plan): actor.img + tokenImg HEAD-probe.
  // Per-item validate_icons already worked but the actor-level portrait URL
  // was never checked. Majesto (phantom URL → 404) and Leo Dilisnya
  // (compendium-default Specter token → resolves but wrong subject) both
  // shipped with the Foundry sheet rendering a broken portrait while
  // `audit-actor actor_only=true validate_icons=true` reported hasImage: true,
  // brokenIconCount: 0. classifyIconUrl closes that gap.

  it('returns missing for null/undefined/empty URL', async () => {
    expect(await classifyIconUrl(null)).toEqual({ url: null, status: 'missing' });
    expect(await classifyIconUrl(undefined)).toEqual({ url: null, status: 'missing' });
    expect(await classifyIconUrl('')).toEqual({ url: null, status: 'missing' });
  });

  it('returns trusted for systems/* paths (Foundry-bundled assets — not probable from backend)', async () => {
    expect(await classifyIconUrl('systems/dnd5e/tokens/undead/Specter.webp'))
      .toEqual({ url: 'systems/dnd5e/tokens/undead/Specter.webp', status: 'trusted' });
  });

  it('returns trusted for modules/* paths', async () => {
    expect(await classifyIconUrl('modules/beneos-module/icons/wand.webp'))
      .toEqual({ url: 'modules/beneos-module/icons/wand.webp', status: 'trusted' });
  });

  it('returns valid when validateIconUrl HEAD-probe succeeds', async () => {
    const spy = vi.spyOn(featIcons, 'validateIconUrl').mockResolvedValue(true);
    try {
      const result = await classifyIconUrl('https://assets.forge-vtt.com/xyz/cos-npc-portraits/Leo%20Dilisnya.png');
      expect(result.status).toBe('valid');
      expect(result.url).toBe('https://assets.forge-vtt.com/xyz/cos-npc-portraits/Leo%20Dilisnya.png');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns broken when validateIconUrl HEAD-probe fails — the Majesto phantom-URL case', async () => {
    const spy = vi.spyOn(featIcons, 'validateIconUrl').mockResolvedValue(false);
    try {
      // Majesto's actor.img pointed at this path; only `majesto_token.webp` actually existed.
      const result = await classifyIconUrl('https://assets.forge-vtt.com/xyz/cos_tokens/majesto.webp');
      expect(result.status).toBe('broken');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('compareActor — TRAIT_RULES (Midi ActiveEffect changes[] verification)', () => {
  const baseSystem = {
    attributes: { hp: { max: 100 }, ac: { flat: 14 } },
    abilities: {
      str: { value: 16 }, dex: { value: 14 }, con: { value: 16 },
      int: { value: 10 }, wis: { value: 12 }, cha: { value: 12 },
    },
  };

  it('passes when Pack Tactics feat has the canonical Midi advantage flag', () => {
    const sb = makeStatblock({
      traits: [{ name: 'Pack Tactics', description: 'd', parsed: { damage: [] } }],
    });
    const actor = makeActor(baseSystem, [{
      name: 'Pack Tactics',
      type: 'feat',
      effects: [{
        name: 'Pack Tactics',
        changes: [{ key: 'flags.midi-qol.advantage.attack.all', value: 'findNearby(...)', mode: 0 }],
      }],
    }]);
    const audit = compareActor(actor, sb);
    expect(audit.traitsList.find(d => d.field === 'traits.Pack Tactics.changes')).toBeUndefined();
  });

  it('flags Pack Tactics feat missing the Midi flag as critical', () => {
    const sb = makeStatblock({
      traits: [{ name: 'Pack Tactics', description: 'd', parsed: { damage: [] } }],
    });
    const actor = makeActor(baseSystem, [{
      name: 'Pack Tactics',
      type: 'feat',
      effects: [], // no Midi changes — description-only feat masquerading as the trait
    }]);
    const audit = compareActor(actor, sb);
    const div = audit.traitsList.find(d => d.field === 'traits.Pack Tactics.changes');
    expect(div).toBeDefined();
    expect(div!.severity).toBe('critical');
    expect(div!.status).toBe('missing');
    expect(div!.note).toContain('flags.midi-qol.advantage.attack.all');
  });

  it('flags Sunlight Hypersensitivity missing the OverTime damage tick as critical', () => {
    const sb = makeStatblock({
      traits: [{ name: 'Sunlight Hypersensitivity', description: 'd', parsed: { damage: [] } }],
    });
    // Has disadvantage flags but missing OverTime — Volenta 2026-05-02 bug shape.
    const actor = makeActor(baseSystem, [{
      name: 'Sunlight Hypersensitivity',
      type: 'feat',
      effects: [{
        changes: [
          { key: 'flags.midi-qol.disadvantage.attack.all', value: '1', mode: 0 },
          { key: 'flags.midi-qol.disadvantage.ability.check.all', value: '1', mode: 0 },
        ],
      }],
    }]);
    const audit = compareActor(actor, sb);
    const div = audit.traitsList.find(d => d.field === 'traits.Sunlight Hypersensitivity.changes');
    expect(div).toBeDefined();
    expect(div!.severity).toBe('critical');
    expect(div!.status).toBe('divergence');
    expect(div!.note).toContain('flags.midi-qol.OverTime.sunlightHypersensitivity');
  });

  it('passes Magic Resistance with canonical key', () => {
    const sb = makeStatblock({
      traits: [{ name: 'Magic Resistance', description: 'd', parsed: { damage: [] } }],
    });
    const actor = makeActor(baseSystem, [{
      name: 'Magic Resistance',
      type: 'feat',
      effects: [{ changes: [{ key: 'flags.midi-qol.magicResistance.all', value: '1', mode: 0 }] }],
    }]);
    const audit = compareActor(actor, sb);
    expect(audit.traitsList.find(d => d.field === 'traits.Magic Resistance.changes')).toBeUndefined();
  });

  it('passes Regeneration with canonical OverTime key', () => {
    const sb = makeStatblock({
      traits: [{ name: 'Regeneration', description: 'regains 10 hit points', parsed: { damage: [] } }],
    });
    const actor = makeActor(baseSystem, [{
      name: 'Regeneration',
      type: 'feat',
      effects: [{ changes: [{ key: 'flags.midi-qol.OverTime.regeneration', value: 'turn=start,damageRoll=10,...', mode: 0 }] }],
    }]);
    const audit = compareActor(actor, sb);
    expect(audit.traitsList.find(d => d.field === 'traits.Regeneration.changes')).toBeUndefined();
  });

  it('skips description-only traits (not in registry) — no false positive', () => {
    const sb = makeStatblock({
      traits: [{ name: 'Close Quarters Fighter', description: 'narrative only', parsed: { damage: [] } }],
    });
    const actor = makeActor(baseSystem, [{
      name: 'Close Quarters Fighter',
      type: 'feat',
      effects: [], // intentionally no Midi changes — description-only is fine
    }]);
    const audit = compareActor(actor, sb);
    expect(audit.traitsList.find(d => d.field?.startsWith('traits.Close Quarters Fighter'))).toBeUndefined();
  });

  it('does not fire when the matched item is missing (compareFeatures already reports that)', () => {
    const sb = makeStatblock({
      traits: [{ name: 'Pack Tactics', description: 'd', parsed: { damage: [] } }],
    });
    const actor = makeActor(baseSystem, []); // no items at all
    const audit = compareActor(actor, sb);
    expect(audit.traitsList.find(d => d.field === 'traits.Pack Tactics.changes')).toBeUndefined();
    // missingFromActor is the appropriate signal here.
    expect(audit.features.missingFromActor).toContain('Pack Tactics');
  });
});

describe('compareActor — usage.recharge / usage.uses rules', () => {
  it('passes when parsed (Recharge 5-6) matches item recovery formula', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Wail of the Forsaken',
        description: 'd',
        parsed: { damage: [], usage: { recharge: [5, 6] } as any },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Wail of the Forsaken', type: 'feat', system: {
        activities: { sav1: { type: 'save' } },
        uses: {
          max: '1',
          recovery: [{ period: 'recharge', formula: '5-6' }],
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const item = audit.actions.find(a => a.name === 'Wail of the Forsaken');
    expect(item!.divergences.find(d => d.field === 'usage.recharge')).toBeUndefined();
  });

  it('flags wrong recharge formula as medium (Wail of the Forsaken regression)', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Wail of the Forsaken',
        description: 'd',
        parsed: { damage: [], usage: { recharge: [5, 6] } as any },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Wail of the Forsaken', type: 'feat', system: {
        activities: { sav1: { type: 'save' } },
        uses: {
          max: '1',
          recovery: [{ period: 'recharge', formula: '6' }], // wrong — Reloaded says 5-6
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const item = audit.actions.find(a => a.name === 'Wail of the Forsaken');
    const div = item!.divergences.find(d => d.field === 'usage.recharge');
    expect(div).toBeDefined();
    expect(div!.severity).toBe('medium');
    expect((div!.reloaded as any).formula).toBe('5-6');
    expect((div!.foundry as any).formula).toBe('6');
  });

  it('flags missing recharge entry as missing', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Frightful Presence',
        description: 'd',
        parsed: { damage: [], usage: { recharge: [4, 6] } as any },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Frightful Presence', type: 'feat', system: {
        activities: { sav1: { type: 'save' } },
        uses: { max: '1', recovery: [] },
      },
    }]);
    const audit = compareActor(actor, sb);
    const item = audit.actions.find(a => a.name === 'Frightful Presence');
    const div = item!.divergences.find(d => d.field === 'usage.recharge');
    expect(div).toBeDefined();
    expect(div!.status).toBe('missing');
  });

  it('passes when parsed (1/Day) matches item uses.max + period', () => {
    const sb = makeStatblock({
      actions: [{
        name: 'Heroic Surge',
        description: 'd',
        parsed: { damage: [], usage: { count: 1, period: 'day' } as any },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Heroic Surge', type: 'feat', system: {
        activities: { sav1: { type: 'save' } },
        uses: { max: '1', recovery: [{ period: 'day' }] },
      },
    }]);
    const audit = compareActor(actor, sb);
    const item = audit.actions.find(a => a.name === 'Heroic Surge');
    expect(item!.divergences.find(d => d.field === 'usage.uses')).toBeUndefined();
  });
});

describe('compareActor — midiProperties.saveDamage rule', () => {
  it('passes when item.flags.midiProperties.saveDamage matches parsed onSuccess=half', () => {
    const sb = makeStatblock({
      bonusActions: [{
        name: 'Wisplight Flare',
        description: 'd',
        parsed: {
          damage: [{ formula: '4d6', type: 'radiant' }],
          save: { dc: 16, ability: 'con', onSuccess: 'half' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Wisplight Flare', type: 'spell',
      flags: { midiProperties: { saveDamage: 'halfdam' } },
      system: {
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['con'], dc: { calculation: '', formula: '16' } },
            damage: { parts: [{ custom: { enabled: true, formula: '4d6' }, types: ['radiant'] }], onSave: 'half' },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const item = audit.actions.find(a => a.name === 'Wisplight Flare');
    expect(item!.divergences.find(d => d.field === 'midiProperties.saveDamage')).toBeUndefined();
  });

  it('flags missing saveDamage flag when parsed says onSuccess=half', () => {
    const sb = makeStatblock({
      bonusActions: [{
        name: 'Wisplight Flare',
        description: 'd',
        parsed: {
          damage: [{ formula: '4d6', type: 'radiant' }],
          save: { dc: 16, ability: 'con', onSuccess: 'half' },
        },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Wisplight Flare', type: 'spell',
      // No flags.midiProperties → defaults to full-damage-on-fail
      system: {
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['con'], dc: { calculation: '', formula: '16' } },
            damage: { parts: [{ custom: { enabled: true, formula: '4d6' }, types: ['radiant'] }] },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const item = audit.actions.find(a => a.name === 'Wisplight Flare');
    const div = item!.divergences.find(d => d.field === 'midiProperties.saveDamage');
    expect(div).toBeDefined();
    expect(div!.severity).toBe('medium');
    expect(div!.reloaded).toBe('halfdam');
    expect(div!.foundry).toBeNull();
  });

  it('does not fire when parsed save has no onSuccess (full damage on fail is default)', () => {
    const sb = makeStatblock({
      bonusActions: [{
        name: 'Deathly Visions',
        description: 'd',
        parsed: { damage: [], save: { dc: 16, ability: 'wis' } },
      }],
    });
    const actor = makeActor({ attributes: {}, abilities: {} }, [{
      name: 'Deathly Visions', type: 'feat', system: {
        activities: {
          sav1: {
            type: 'save',
            save: { ability: ['wis'], dc: { calculation: '', formula: '16' } },
          },
        },
      },
    }]);
    const audit = compareActor(actor, sb);
    const item = audit.actions.find(a => a.name === 'Deathly Visions');
    expect(item!.divergences.find(d => d.field === 'midiProperties.saveDamage')).toBeUndefined();
  });
});

describe('checkPortraitCanonMatch — Arc H portrait canon-tag rule', () => {
  it('match: custom canon + cos-npc-portraits/*.png URL', () => {
    expect(checkPortraitCanonMatch(
      'https://assets.forge-vtt.com/xyz/cos-npc-portraits/Leo%20Dilisnya.png',
      'custom',
    )).toBe('match');
  });

  it('mismatch: custom canon + Beneos token URL', () => {
    expect(checkPortraitCanonMatch(
      'https://assets.forge-vtt.com/xyz/moulinette/.../cos_tokens/majesto_token.webp',
      'custom',
    )).toBe('mismatch');
  });

  it('match: beneos canon + cos_tokens/*.webp URL', () => {
    expect(checkPortraitCanonMatch(
      'https://assets.forge-vtt.com/xyz/moulinette/adventures/beneos-battlemaps-universe/beneos_assets/beneos_battlemaps/map_assets/tokens/cos_tokens/majesto_token.webp',
      'beneos',
    )).toBe('match');
  });

  it('mismatch: beneos canon + cos-npc-portraits URL', () => {
    expect(checkPortraitCanonMatch(
      'https://assets.forge-vtt.com/xyz/cos-npc-portraits/Leo%20Dilisnya.png',
      'beneos',
    )).toBe('mismatch');
  });

  it('skipped: needs-upgrade canon never errors', () => {
    expect(checkPortraitCanonMatch(
      'systems/dnd5e/tokens/undead/Specter.webp',
      'needs-upgrade',
    )).toBe('skipped');
  });

  it('skipped: empty / null URL', () => {
    expect(checkPortraitCanonMatch(null, 'custom')).toBe('skipped');
    expect(checkPortraitCanonMatch('', 'beneos')).toBe('skipped');
    expect(checkPortraitCanonMatch('   ', 'custom')).toBe('skipped');
  });
});
