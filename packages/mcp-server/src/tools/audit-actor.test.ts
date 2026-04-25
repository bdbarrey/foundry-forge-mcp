import { describe, it, expect } from 'vitest';
import { compareActor, ActorSnapshot } from './audit-actor.js';
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
