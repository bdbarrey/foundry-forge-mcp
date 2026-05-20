/**
 * DSA5 Filter Tests
 *
 * Validate filter-matching and validation helpers against representative
 * creature data (a low-level martial goblin and a higher-level elf magier).
 */

import { describe, it, expect } from 'vitest';
import {
  matchesDSA5Filters,
  describeDSA5Filters,
  isValidDSA5Species,
  isValidExperienceLevel,
} from './filters.js';
import type { DSA5Filters } from './filters.js';

const testCreature = {
  id: 'test-goblin-1',
  name: 'Goblin Krieger',
  type: 'character',
  systemData: {
    level: 2,
    species: 'goblin',
    culture: 'Bergstamm',
    size: 'small',
    hasSpells: false,
    experiencePoints: 1200,
  },
};

const testSpellcaster = {
  id: 'test-magier-1',
  name: 'Elf Magier',
  type: 'character',
  systemData: {
    level: 5,
    species: 'elf',
    culture: 'Auelfen',
    size: 'medium',
    hasSpells: true,
    experiencePoints: 4000,
  },
};

describe('matchesDSA5Filters', () => {
  it('exact-level filter matches the level-2 goblin and rejects the level-5 magier', () => {
    const f: DSA5Filters = { level: 2 };
    expect(matchesDSA5Filters(testCreature, f)).toBe(true);
    expect(matchesDSA5Filters(testSpellcaster, f)).toBe(false);
  });

  it('level-range filter accepts both creatures inside the {min:2,max:5} band', () => {
    const f: DSA5Filters = { level: { min: 2, max: 5 } };
    expect(matchesDSA5Filters(testCreature, f)).toBe(true);
    expect(matchesDSA5Filters(testSpellcaster, f)).toBe(true);
  });

  it('species filter discriminates goblin from elf', () => {
    const f: DSA5Filters = { species: 'goblin' };
    expect(matchesDSA5Filters(testCreature, f)).toBe(true);
    expect(matchesDSA5Filters(testSpellcaster, f)).toBe(false);
  });

  it('hasSpells filter splits spellcasters from non-casters', () => {
    const f: DSA5Filters = { hasSpells: true };
    expect(matchesDSA5Filters(testCreature, f)).toBe(false);
    expect(matchesDSA5Filters(testSpellcaster, f)).toBe(true);
  });

  it('combined filter (level range + size + hasSpells) AND-narrows correctly', () => {
    const f: DSA5Filters = { level: { min: 1, max: 3 }, size: 'small', hasSpells: false };
    expect(matchesDSA5Filters(testCreature, f)).toBe(true);
    expect(matchesDSA5Filters(testSpellcaster, f)).toBe(false);
  });

  it('experiencePoints range filter respects min/max bounds', () => {
    const f: DSA5Filters = { experiencePoints: { min: 1000, max: 2000 } };
    expect(matchesDSA5Filters(testCreature, f)).toBe(true);
    expect(matchesDSA5Filters(testSpellcaster, f)).toBe(false);
  });
});

describe('describeDSA5Filters', () => {
  it('returns a non-empty string for every filter shape exercised above', () => {
    const filters: DSA5Filters[] = [
      { level: 2 },
      { level: { min: 2, max: 5 } },
      { species: 'goblin' },
      { hasSpells: true },
      { level: { min: 1, max: 3 }, size: 'small', hasSpells: false },
      { experiencePoints: { min: 1000, max: 2000 } },
    ];
    for (const f of filters) {
      const desc = describeDSA5Filters(f);
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
    }
  });
});

describe('validation helpers', () => {
  it('isValidDSA5Species accepts known species and rejects unknown ones', () => {
    expect(isValidDSA5Species('goblin')).toBe(true);
    expect(isValidDSA5Species('unicorn')).toBe(false);
  });

  it('isValidExperienceLevel accepts 1–7 and rejects out-of-range', () => {
    expect(isValidExperienceLevel(3)).toBe(true);
    expect(isValidExperienceLevel(0)).toBe(false);
    expect(isValidExperienceLevel(8)).toBe(false);
  });
});
