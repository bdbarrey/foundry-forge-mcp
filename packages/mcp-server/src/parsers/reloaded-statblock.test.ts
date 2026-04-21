import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseReloadedStatblock } from './reloaded-statblock.js';

const BESTIARY = '/home/bdbarrey/BenOS/cos-pipeline/sources/cos-reloaded/Appendices/Bestiary.md';
const STRAHD_FILE = '/home/bdbarrey/BenOS/cos-pipeline/sources/cos-reloaded/Chapter 2 - The Land of Barovia/Strahd von Zarovich.md';

/**
 * Extract the markdown chunk under a specific `### Heading` in a Reloaded file.
 * Stops at the next `##` or `###`. Keeps the leading heading so parse() can
 * still find the `<div class="statblock">` inside.
 */
function extractSection(file: string, heading: string): string {
  const md = readFileSync(file, 'utf8');
  const lines = md.split(/\r?\n/);

  const startIdx = lines.findIndex(l => l.trim() === `### ${heading}`);
  if (startIdx < 0) throw new Error(`Heading "### ${heading}" not found in ${file}`);

  const endIdx = lines.slice(startIdx + 1).findIndex(l => /^#{1,3}\s/.test(l));
  const end = endIdx < 0 ? lines.length : startIdx + 1 + endIdx;

  return lines.slice(startIdx, end).join('\n');
}

describe('parseReloadedStatblock — Zombie', () => {
  const result = parseReloadedStatblock(extractSection(BESTIARY, 'Zombie'));

  it('identifies name + type line', () => {
    expect(result.name).toBe('Zombie');
    expect(result.size).toBe('Medium');
    expect(result.type).toBe('Undead');
    expect(result.alignment).toBe('Neutral Evil');
    expect(result.subtype).toBe(null);
  });

  it('parses AC / HP / Speed', () => {
    expect(result.ac).toBe(8);
    expect(result.acNote).toBe(null);
    expect(result.hp).toEqual({ avg: 22, formula: '3d8 + 9' });
    expect(result.speed).toEqual({ walk: 20 });
  });

  it('parses ability scores', () => {
    expect(result.abilities.str).toEqual({ score: 13, mod: 1 });
    expect(result.abilities.dex).toEqual({ score: 6, mod: -2 }); // en-dash normalized
    expect(result.abilities.con).toEqual({ score: 16, mod: 3 });
    expect(result.abilities.int).toEqual({ score: 3, mod: -4 });
    expect(result.abilities.wis).toEqual({ score: 6, mod: -2 });
    expect(result.abilities.cha).toEqual({ score: 5, mod: -3 });
  });

  it('parses saves + immunities + senses + challenge', () => {
    expect(result.saves).toEqual({ wis: 0 });
    expect(result.damageImmunities).toBe('Poison');
    expect(result.conditionImmunities).toBe('Poisoned');
    expect(result.passivePerception).toBe(8);
    expect(result.challenge).toBe('1/4');
    expect(result.challengeNumeric).toBe(0.25);
    expect(result.proficiencyBonus).toBe(null); // not printed on basic zombie
  });

  it('extracts traits + actions with name/description split', () => {
    expect(result.traits).toHaveLength(1);
    expect(result.traits[0].name).toBe('Undead Fortitude');
    expect(result.traits[0].description).toMatch(/drops to 1 hit point instead/);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].name).toBe('Slam');
    expect(result.actions[0].description).toMatch(/bludgeoning damage/);

    expect(result.bonusActions).toEqual([]);
    expect(result.reactions).toEqual([]);
    expect(result.legendaryActions).toEqual([]);
  });
});

describe('parseReloadedStatblock — Zombie Plague Spreader', () => {
  const result = parseReloadedStatblock(extractSection(BESTIARY, 'Zombie Plague Spreader'));

  it('parses name (note: h2 uses "Zombie, Plague Spreader" while heading omits comma)', () => {
    expect(result.name).toBe('Zombie, Plague Spreader');
    expect(result.alignment).toBe(''); // no alignment printed
  });

  it('parses AC/HP/Speed + CR + proficiency', () => {
    expect(result.ac).toBe(10);
    expect(result.hp).toEqual({ avg: 78, formula: '12d8 + 24' });
    expect(result.speed).toEqual({ walk: 30 });
    expect(result.challenge).toBe('4');
    expect(result.challengeNumeric).toBe(4);
    expect(result.proficiencyBonus).toBe(2);
  });

  it('parses damage resistances + all three immunity categories', () => {
    expect(result.damageResistances).toBe('Necrotic');
    expect(result.damageImmunities).toBe('Poison');
    expect(result.conditionImmunities).toBe('Charmed, Exhaustion, Poisoned');
  });

  it('captures three traits and three actions', () => {
    expect(result.traits.map(t => t.name)).toEqual(['Undead Fortitude', 'Unusual Nature', 'Viral Aura']);
    expect(result.actions.map(a => a.name)).toEqual(['Multiattack', 'Slam', 'Virulent Miasma (1/Day)']);
    expect(result.traits[2].description).toMatch(/Viral Aura for 24 hours/);
    expect(result.actions[2].description).toMatch(/30.foot.radius sphere/);
  });
});

describe('parseReloadedStatblock — Strahd, the Mage', () => {
  const result = parseReloadedStatblock(extractSection(STRAHD_FILE, 'The Mage'));

  it('parses name + subtype + alignment', () => {
    expect(result.name).toBe('Strahd, the Mage');
    expect(result.size).toBe('Medium');
    // "Medium undead (shapechanger), lawful evil"
    expect(result.type.toLowerCase()).toBe('undead');
    expect(result.subtype).toBe('shapechanger');
    expect(result.alignment.toLowerCase()).toBe('lawful evil');
  });

  it('parses high-CR numerics', () => {
    expect(result.ac).toBe(16);
    expect(result.acNote).toBe('natural armor');
    expect(result.hp).toEqual({ avg: 331, formula: '39d8 + 156' });
    expect(result.speed).toEqual({ walk: 40, climb: 40 });
  });

  it('parses all six abilities', () => {
    expect(result.abilities.str).toEqual({ score: 20, mod: 5 });
    expect(result.abilities.dex).toEqual({ score: 20, mod: 5 });
    expect(result.abilities.con).toEqual({ score: 18, mod: 4 });
    expect(result.abilities.int).toEqual({ score: 20, mod: 5 });
    expect(result.abilities.wis).toEqual({ score: 15, mod: 2 });
    expect(result.abilities.cha).toEqual({ score: 20, mod: 5 });
  });

  it('parses multi-entry saves + skills + complex CR', () => {
    expect(result.saves).toEqual({ dex: 12, wis: 9, cha: 12 });
    expect(result.skills.arcana).toBe(19);
    expect(result.skills.stealth).toBe(19);
    expect(result.skills.perception).toBe(16);
    expect(result.damageResistances).toMatch(/necrotic/);
    expect(result.passivePerception).toBe(24);
    // "21, or 19 when fought in sunlight" — we keep the raw + parse leading int
    expect(result.challenge.startsWith('21')).toBe(true);
    expect(result.challengeNumeric).toBe(21);
    expect(result.proficiencyBonus).toBe(7);
  });

  it('captures Strahd the Mage traits + at least three action groups', () => {
    // Mage has: Close Quarters Fighter, Complex Casting, Regeneration (before Actions h3)
    const traitNames = result.traits.map(t => t.name);
    expect(traitNames).toContain('Close Quarters Fighter');
    expect(traitNames).toContain('Regeneration');

    // Actions / Bonus Actions / Reactions all present
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.bonusActions.length).toBeGreaterThan(0);
    expect(result.reactions.length).toBeGreaterThan(0);

    const actionNames = result.actions.map(a => a.name);
    expect(actionNames).toContain('Multiattack');
    expect(actionNames).toContain('Vampiric Touch');

    const bonusNames = result.bonusActions.map(a => a.name);
    expect(bonusNames).toContain('Circle of Sickness');

    const reactionNames = result.reactions.map(a => a.name);
    expect(reactionNames).toContain('Misty Step');
  });
});

describe('parseReloadedStatblock — error paths', () => {
  it('throws when no statblock div is present', () => {
    expect(() => parseReloadedStatblock('<p>just a paragraph</p>')).toThrowError(/No <div class="statblock">/);
  });

  it('throws when h2 is missing', () => {
    const bad = '<div class="statblock"><em>Medium Undead</em></div>';
    expect(() => parseReloadedStatblock(bad)).toThrowError(/missing <h2>/);
  });
});
