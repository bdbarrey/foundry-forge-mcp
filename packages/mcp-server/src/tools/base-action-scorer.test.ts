import { describe, expect, it } from 'vitest';
import type { ParsedAction } from '../parsers/action-description.js';
import {
  ACTION_CONFIDENCE_FLOOR,
  ActionCandidateFull,
  actionNameVariants,
  normalizeActionName,
  passesHardFilters,
  scoreActionCandidate,
} from './base-action-scorer.js';

describe('normalizeActionName', () => {
  it('strips usage parentheticals', () => {
    expect(normalizeActionName('Thunderstone (1/day)')).toBe('thunderstone');
    expect(normalizeActionName('Fire Breath (Recharge 5-6)')).toBe('fire breath');
  });
  it('passes through names without parentheticals', () => {
    expect(normalizeActionName('Dagger')).toBe('dagger');
    expect(normalizeActionName("Alchemist's Firebomb")).toBe("alchemist's firebomb");
  });
});

describe('actionNameVariants', () => {
  it('yields exact name + single-word stems for multi-word actions', () => {
    const vars = [...actionNameVariants('Hail of Daggers')];
    expect(vars).toContain('hail of daggers');
    expect(vars).toContain('dagger'); // "daggers" stripped of plural
  });
  it('includes Reloaded→SRD mappings for known reskins', () => {
    const firebomb = [...actionNameVariants("Alchemist's Firebomb (1/day)")];
    expect(firebomb).toContain("alchemist's firebomb");
    expect(firebomb).toContain("alchemist's fire");
  });
  it('handles single-word names', () => {
    expect([...actionNameVariants('Dagger')]).toEqual(['dagger']);
  });
});

describe('passesHardFilters', () => {
  const base = (overrides: Partial<any> = {}) => ({
    packId: 'pack', itemId: 'id', name: 'Thing', type: 'feat', ...overrides,
  });
  it('rejects empty candidates', () => {
    expect(passesHardFilters({ damage: [] }, base({ itemId: '' }))).toBe(false);
    expect(passesHardFilters({ damage: [] }, base({ packId: '' }))).toBe(false);
  });
  it('rejects disallowed types (class, race, background, subclass, tool)', () => {
    const action: ParsedAction = { damage: [] };
    for (const t of ['class', 'subclass', 'race', 'background', 'tool']) {
      expect(passesHardFilters(action, base({ type: t }))).toBe(false);
    }
  });
  it('accepts action-shaped types (weapon, consumable, spell, feat, equipment)', () => {
    const action: ParsedAction = { damage: [] };
    for (const t of ['weapon', 'consumable', 'spell', 'feat', 'equipment']) {
      expect(passesHardFilters(action, base({ type: t }))).toBe(true);
    }
  });
});

describe('scoreActionCandidate — Volenta cases (confirmed live)', () => {
  it('Thunderstone (1/day) vs SRD Thunderstone: high-confidence match', () => {
    const action: ParsedAction = {
      damage: [],
      save: { dc: 14, ability: 'con' },
      usage: { count: 1, period: 'day' },
      target: 'each creature in a 10-foot radius',
    };
    const candidate: ActionCandidateFull = {
      packId: 'dnd5e.items', itemId: 'thunderstone', name: 'Thunderstone', type: 'consumable',
      activityTypes: new Set(['save']),
      damageTypes: new Set(['thunder']),
      saveAbilities: new Set(),
      damageMagnitude: 3.5,
      range: 30,
    };
    const score = scoreActionCandidate(action, candidate, 'Thunderstone (1/day)');
    expect(score.overall).toBeGreaterThanOrEqual(ACTION_CONFIDENCE_FLOOR);
    expect(score.components.nameMatch).toBe(1.0);
    expect(score.rationale).toContain('exact name match');
  });

  it("Alchemist's Firebomb (1/day) vs SRD Alchemist's Fire: matches via stem mapping", () => {
    const action: ParsedAction = {
      damage: [{ formula: '2d6', type: 'fire' }],
      save: { dc: 14, ability: 'dex' },
      usage: { count: 1, period: 'day' },
    };
    const candidate: ActionCandidateFull = {
      packId: 'dnd5e.items', itemId: 'af', name: "Alchemist's Fire", type: 'consumable',
      activityTypes: new Set(['attack', 'save']),
      damageTypes: new Set(['fire']),
      saveAbilities: new Set(),
      damageMagnitude: 2.5,
      range: 20,
    };
    const score = scoreActionCandidate(action, candidate, "Alchemist's Firebomb (1/day)");
    expect(score.overall).toBeGreaterThanOrEqual(ACTION_CONFIDENCE_FLOOR);
    // Should flag shared fire damage
    expect(score.rationale.some(r => r.includes('fire'))).toBe(true);
  });

  it('Hail of Daggers vs Dagger: name overlap + ranged attack category match → above floor', () => {
    const action: ParsedAction = {
      attackType: 'ranged',
      attackBonus: 7,
      range: { normal: 15 },
      damage: [{ formula: '2d4 + 4', type: 'piercing' }],
    };
    const candidate: ActionCandidateFull = {
      packId: 'dnd5e.items', itemId: 'dagger', name: 'Dagger', type: 'weapon',
      activityTypes: new Set(['attack']),
      damageTypes: new Set(['piercing']),
      saveAbilities: new Set(),
      damageMagnitude: 2.5,
      range: 20,
    };
    const score = scoreActionCandidate(action, candidate, 'Hail of Daggers');
    expect(score.overall).toBeGreaterThanOrEqual(ACTION_CONFIDENCE_FLOOR);
  });

  it('Smokestick vs any SRD item: low-confidence, below floor → scratch-build signal', () => {
    const action: ParsedAction = {
      damage: [],
      usage: { count: 1, period: 'day' },
    };
    const poorCandidate: ActionCandidateFull = {
      packId: 'dnd5e.items', itemId: 'torch', name: 'Torch', type: 'equipment',
      activityTypes: new Set(),
      damageTypes: new Set(),
      saveAbilities: new Set(),
      damageMagnitude: 0,
      range: null,
    };
    const score = scoreActionCandidate(action, poorCandidate, 'Smokestick (1/day)');
    expect(score.overall).toBeLessThan(ACTION_CONFIDENCE_FLOOR);
  });

  it('category mismatch penalizes: save-action vs attack-only candidate', () => {
    const saveAction: ParsedAction = {
      damage: [{ formula: '2d4', type: 'acid' }],
      save: { dc: 14, ability: 'str' },
    };
    const attackOnlyCandidate: ActionCandidateFull = {
      packId: 'p', itemId: 'i', name: 'Sword', type: 'weapon',
      activityTypes: new Set(['attack']),
      damageTypes: new Set(['slashing']),
      saveAbilities: new Set(),
      damageMagnitude: 5,
      range: 5,
    };
    const score = scoreActionCandidate(saveAction, attackOnlyCandidate, 'Acid Spray');
    // Category mismatch + no damage overlap + no name match should floor it low
    expect(score.components.categoryMatch).toBeLessThan(0.5);
    expect(score.overall).toBeLessThan(ACTION_CONFIDENCE_FLOOR);
  });
});
