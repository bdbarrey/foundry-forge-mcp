import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseReloadedStatblock } from '../parsers/reloaded-statblock.js';
import {
  CandidateBasic,
  CandidateFull,
  CONFIDENCE_FLOOR,
  normalizeCreatureType,
  normalizeSize,
  passesHardFilters,
  preScore,
  scoreCandidate,
} from './base-monster-scorer.js';

const ARC_D = '/home/bdbarrey/BenOS/cos-pipeline/sources/cos-reloaded/Act II - The Shadowed Town/Arc D - St. Andral\'s Feast.md';

function extractDivByHeading(file: string, heading: string): string {
  const md = readFileSync(file, 'utf8');
  // Volenta's statblocks live inside <h2> headings within <div class="statblock">
  // blocks in the middle of the file, not under `### Heading`. Find the statblock
  // whose first <h2> matches.
  const match = md.match(new RegExp(
    `<div class="statblock">\\s*<h2>\\s*${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*</h2>[\\s\\S]*?</div>`,
  ));
  if (!match) throw new Error(`Statblock with <h2>${heading}</h2> not found in ${file}`);
  return match[0];
}

describe('normalizeCreatureType', () => {
  it('strips parentheticals and lowercases', () => {
    expect(normalizeCreatureType('Humanoid (shapechanger)')).toBe('humanoid');
    expect(normalizeCreatureType('Undead')).toBe('undead');
    expect(normalizeCreatureType('undead')).toBe('undead');
  });
  it('strips size prefix when present', () => {
    expect(normalizeCreatureType('Medium beast')).toBe('beast');
  });
  it('returns null for null', () => {
    expect(normalizeCreatureType(null)).toBe(null);
  });
});

describe('normalizeSize', () => {
  it('maps words to dnd5e codes', () => {
    expect(normalizeSize('Medium')).toBe('med');
    expect(normalizeSize('Large')).toBe('lg');
    expect(normalizeSize('Gargantuan')).toBe('grg');
  });
  it('passes through codes unchanged', () => {
    expect(normalizeSize('med')).toBe('med');
    expect(normalizeSize('grg')).toBe('grg');
  });
});

describe('infer-base-monster scoring — Volenta First Form → Vampire Spawn', () => {
  const sb = parseReloadedStatblock(extractDivByHeading(ARC_D, 'Volenta, First Form'));

  // Hand-built candidates modeled after MM entries at the structural level.
  // HP/AC come from the full doc; basic-tier fields (without HP/AC) are used
  // for the pre-filter + pre-score step only.
  const vampireSpawn: CandidateFull = {
    packId: 'dnd5e.monsters', itemId: 'vampire-spawn',
    name: 'Vampire Spawn',
    cr: 5, creatureType: 'undead', size: 'med',
    hp: 82, ac: 15,
    abilities: { str: 16, dex: 16, con: 16, int: 11, wis: 10, cha: 12 },
    featNames: new Set(['regeneration', 'spider climb', 'vampire weaknesses']),
    itemNames: new Set(['regeneration', 'spider climb', 'vampire weaknesses', 'multiattack', 'claws', 'bite']),
  };

  const wight: CandidateFull = {
    packId: 'dnd5e.monsters', itemId: 'wight',
    name: 'Wight',
    cr: 3, creatureType: 'undead', size: 'med',
    hp: 45, ac: 14,
    abilities: { str: 15, dex: 14, con: 16, int: 10, wis: 13, cha: 15 },
    featNames: new Set(['sunlight sensitivity']),
    itemNames: new Set(['sunlight sensitivity', 'multiattack', 'life drain', 'longsword', 'longbow']),
  };

  const mummy: CandidateFull = {
    packId: 'dnd5e.monsters', itemId: 'mummy',
    name: 'Mummy',
    cr: 3, creatureType: 'undead', size: 'med',
    hp: 58, ac: 11,
    abilities: { str: 16, dex: 8, con: 15, int: 6, wis: 10, cha: 12 },
    featNames: new Set([]),
    itemNames: new Set(['multiattack', 'rotting fist', 'dreadful glare']),
  };

  // Vampire is CR 13 — should be hard-filtered out of the CR±2 window.
  const vampireBasic: CandidateBasic = {
    packId: 'dnd5e.monsters', itemId: 'vampire',
    name: 'Vampire',
    cr: 13, creatureType: 'undead', size: 'med',
    hp: 144, ac: 16,
  };

  it('parses Volenta correctly enough to score', () => {
    expect(sb.name).toBe('Volenta, First Form');
    expect(sb.challengeNumeric).toBe(5);
    expect(sb.hp.avg).toBe(82);
    expect(sb.ac).toBe(15);
    expect(sb.abilities.dex.score).toBe(18);
    // Key traits the scorer will match against
    const traitNames = sb.traits.map(t => t.name.toLowerCase());
    expect(traitNames).toContain('regeneration');
    expect(traitNames).toContain('spider climb');
  });

  it('hard-filters Vampire out on CR delta > 2', () => {
    expect(passesHardFilters(sb, vampireBasic)).toBe(false);
  });

  it('keeps CR-matched undead through hard filter', () => {
    expect(passesHardFilters(sb, vampireSpawn)).toBe(true);
    expect(passesHardFilters(sb, wight)).toBe(true);
    expect(passesHardFilters(sb, mummy)).toBe(true);
  });

  it('ranks Vampire Spawn highest', () => {
    const ranked = [vampireSpawn, wight, mummy]
      .map(c => ({ name: c.name, score: scoreCandidate(sb, c).overall }))
      .sort((a, b) => b.score - a.score);

    expect(ranked[0].name).toBe('Vampire Spawn');
    // Eyeballing: we expect the top score to clear the confidence floor
    // thanks to HP equality + trait overlap on Regeneration + Spider Climb.
    expect(ranked[0].score).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
  });

  it('Vampire Spawn beats Wight by a clear margin', () => {
    const spawnScore = scoreCandidate(sb, vampireSpawn).overall;
    const wightScore = scoreCandidate(sb, wight).overall;
    expect(spawnScore - wightScore).toBeGreaterThan(0.1);
  });

  it('pre-score also ranks Vampire Spawn first (CR + size, no traits needed)', () => {
    const ranked = [vampireSpawn, wight, mummy]
      .map(c => ({ name: c.name, pre: preScore(sb, c) }))
      .sort((a, b) => b.pre - a.pre);
    expect(ranked[0].name).toBe('Vampire Spawn');
  });
});

describe('low-confidence fallback', () => {
  // A Reloaded creature with no plausible compendium match should produce a
  // sub-floor top score.
  const sb = parseReloadedStatblock(`
<div class="statblock">
<h2>Weirdblob, Alien Construct</h2>
<em>Huge aberration, chaotic evil</em>
<hr>
<strong>Armor Class</strong> 22 (reality warp)
<br>
<strong>Hit Points</strong> 444 (40d12 + 280)
<br>
<strong>Speed</strong> 10 ft., fly 120 ft. (hover)
<hr>
<table class="ability-table"><thead><tr>
<th>STR</th><th>DEX</th><th>CON</th><th>INT</th><th>WIS</th><th>CHA</th>
</tr></thead><tbody><tr>
<td>30 (+10)</td><td>8 (-1)</td><td>24 (+7)</td><td>22 (+6)</td><td>18 (+4)</td><td>20 (+5)</td>
</tr></tbody></table>
<hr>
<strong>Challenge</strong> 20 (25,000 XP)<br>
<hr>
<p><strong><em>Extradimensional Madness.</em></strong> Totally custom trait.</p>
</div>
`);

  it('parses the exotic statblock', () => {
    expect(sb.challengeNumeric).toBe(20);
    expect(sb.type.toLowerCase()).toBe('aberration');
  });

  it('CR-30 beholder-shaped candidate with low trait overlap scores low', () => {
    // Built to pass hard filters (same type, CR within ±2 window) but with
    // no shared traits and very different ability scores.
    const stranger: CandidateFull = {
      packId: 'pack', itemId: 'x', name: 'Random Aberration',
      cr: 20, creatureType: 'aberration', size: 'huge',
      hp: 180, ac: 17,
      abilities: { str: 12, dex: 14, con: 12, int: 18, wis: 14, cha: 16 },
      featNames: new Set(['telepathy', 'innate spellcasting']),
      itemNames: new Set(['telepathy', 'innate spellcasting', 'bite', 'tail slap']),
    };
    const score = scoreCandidate(sb, stranger).overall;
    expect(score).toBeLessThan(CONFIDENCE_FLOOR);
  });
});
