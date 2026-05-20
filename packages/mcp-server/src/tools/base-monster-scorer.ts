// Pure scoring functions for infer-base-monster.
//
// Given a parsed Reloaded statblock and a compendium candidate (with enough
// detail to compare traits and ability scores), produce a 0..1 similarity
// score + a per-feature breakdown and a short human-readable rationale.
//
// This module is deliberately dependency-free (no Foundry queries) so it can
// be unit-tested in isolation and called in tight loops over candidate lists.

import type { ReloadedStatblock } from '../parsers/reloaded-statblock.js';

export interface CandidateBasic {
  packId: string;
  itemId: string;
  name: string;
  /** Challenge rating. Numeric (5, 0.25, 13). Null means unknown → excluded by hard filter. */
  cr: number | null;
  /** Normalized lowercase type like "undead", "humanoid". */
  creatureType: string | null;
  /** Normalized size code: "tiny", "sm", "med", "lg", "huge", "grg" (dnd5e). */
  size: string | null;
  hp: number | null;
  ac: number | null;
}

export interface CandidateFull extends CandidateBasic {
  abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  /** Lowercased names of every feat-type item on the actor (traits + feature-style actions). */
  featNames: Set<string>;
  /** Lowercased names of every item regardless of type — covers weapon attacks. */
  itemNames: Set<string>;
}

export interface ScoreBreakdown {
  overall: number;
  components: {
    crDelta: number;
    hpDelta: number;
    acDelta: number;
    sizeMatch: number;
    abilityCosine: number;
    traitOverlap: number;
    actionOverlap: number;
  };
  rationale: string[];
}

/**
 * Component weights. Must sum to 1.0.
 *
 * Trait overlap dominates (0.35) because shared named traits are the strongest
 * structural fingerprint — two CR-5 undead with identical HP can still be very
 * different creatures, but if they both have "Regeneration" + "Spider Climb" +
 * "Sunlight Hypersensitivity" they are almost certainly the same base family.
 */
const WEIGHTS = {
  crDelta: 0.15,
  hpDelta: 0.10,
  acDelta: 0.05,
  sizeMatch: 0.05,
  abilityCosine: 0.15,
  traitOverlap: 0.35,
  actionOverlap: 0.15,
} as const;

/** Candidates whose top score falls below this floor are flagged low-confidence. */
export const CONFIDENCE_FLOOR = 0.55;

/**
 * Normalize a Reloaded type-line ("Humanoid (shapechanger)", "Undead", "Large beast")
 * to a lowercase dnd5e creature-type token ("humanoid", "undead", "beast").
 */
export function normalizeCreatureType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/\([^)]*\)/g, '').trim().toLowerCase();
  // Drop size prefix if someone passed the full Reloaded first line.
  const withoutSize = stripped.replace(
    /^(tiny|small|medium|large|huge|gargantuan)\s+/,
    '',
  );
  const known = new Set([
    'aberration', 'beast', 'celestial', 'construct', 'dragon', 'elemental',
    'fey', 'fiend', 'giant', 'humanoid', 'monstrosity', 'ooze', 'plant',
    'undead',
  ]);
  for (const token of withoutSize.split(/\s+/)) {
    if (known.has(token)) return token;
  }
  return withoutSize || null;
}

const SIZE_CODE_TO_WORD: Record<string, string> = {
  tiny: 'tiny', sm: 'small', med: 'medium', lg: 'large', huge: 'huge', grg: 'gargantuan',
};
const SIZE_WORD_TO_CODE: Record<string, string> = {
  tiny: 'tiny', small: 'sm', medium: 'med', large: 'lg', huge: 'huge', gargantuan: 'grg',
};

/** Normalize Reloaded size ("Medium") or dnd5e code ("med") to the dnd5e code. */
export function normalizeSize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (SIZE_CODE_TO_WORD[lower]) return lower;
  if (SIZE_WORD_TO_CODE[lower]) return SIZE_WORD_TO_CODE[lower];
  return null;
}

/**
 * Hard filters before scoring. Returns true if the candidate is worth scoring.
 *
 * - Type must match (Reloaded "Undead" will not be scored against a Humanoid).
 * - CR must be within ±2 of Reloaded (a CR-13 Vampire is not a base for CR-5
 *   Volenta; heavy override territory is worse than scratch-build).
 * - Missing CR / type on the candidate → reject (incomparable).
 */
export function passesHardFilters(sb: ReloadedStatblock, c: CandidateBasic): boolean {
  if (c.cr === null) return false;
  if (c.creatureType === null) return false;

  const sbType = normalizeCreatureType(sb.type);
  const cType = normalizeCreatureType(c.creatureType);
  if (sbType && cType && sbType !== cType) return false;

  const sbCr = sb.challengeNumeric;
  if (sbCr !== null && Math.abs(c.cr - sbCr) > 2) return false;

  return true;
}

/** Cheap pre-score using only basic fields — for ranking before we fetch full docs. */
export function preScore(sb: ReloadedStatblock, c: CandidateBasic): number {
  let score = 0;
  let weightUsed = 0;

  if (c.cr !== null && sb.challengeNumeric !== null) {
    score += WEIGHTS.crDelta * crProximity(sb.challengeNumeric, c.cr);
    weightUsed += WEIGHTS.crDelta;
  }
  if (c.hp !== null) {
    score += WEIGHTS.hpDelta * hpProximity(sb.hp.avg, c.hp);
    weightUsed += WEIGHTS.hpDelta;
  }
  if (c.ac !== null) {
    score += WEIGHTS.acDelta * acProximity(sb.ac, c.ac);
    weightUsed += WEIGHTS.acDelta;
  }
  const sbSize = normalizeSize(sb.size);
  if (sbSize && c.size) {
    score += WEIGHTS.sizeMatch * (sbSize === c.size ? 1 : 0);
    weightUsed += WEIGHTS.sizeMatch;
  }

  return weightUsed > 0 ? score / weightUsed : 0;
}

/** Full score including ability cosine and trait/action overlap. */
export function scoreCandidate(sb: ReloadedStatblock, c: CandidateFull): ScoreBreakdown {
  const crScore = c.cr !== null && sb.challengeNumeric !== null
    ? crProximity(sb.challengeNumeric, c.cr)
    : 0;
  const hpScore = c.hp !== null ? hpProximity(sb.hp.avg, c.hp) : 0;
  const acScore = c.ac !== null ? acProximity(sb.ac, c.ac) : 0;
  const sbSize = normalizeSize(sb.size);
  const sizeScore = (sbSize && c.size && sbSize === c.size) ? 1 : 0;

  const sbAbilityVec = [
    sb.abilities.str.score, sb.abilities.dex.score, sb.abilities.con.score,
    sb.abilities.int.score, sb.abilities.wis.score, sb.abilities.cha.score,
  ];
  const cAbilityVec = [
    c.abilities.str, c.abilities.dex, c.abilities.con,
    c.abilities.int, c.abilities.wis, c.abilities.cha,
  ];
  const abilityScore = cosineSimilarity(sbAbilityVec, cAbilityVec);

  const sbTraitNames = new Set(sb.traits.map(t => t.name.toLowerCase()));
  const traitOverlapScore = jaccard(sbTraitNames, c.featNames);

  const sbActionNames = new Set([
    ...sb.actions, ...sb.bonusActions, ...sb.reactions,
    ...sb.legendaryActions, ...sb.lairActions,
  ].map(a => a.name.toLowerCase()));
  const actionOverlapScore = jaccard(sbActionNames, c.itemNames);

  const overall =
    WEIGHTS.crDelta * crScore +
    WEIGHTS.hpDelta * hpScore +
    WEIGHTS.acDelta * acScore +
    WEIGHTS.sizeMatch * sizeScore +
    WEIGHTS.abilityCosine * abilityScore +
    WEIGHTS.traitOverlap * traitOverlapScore +
    WEIGHTS.actionOverlap * actionOverlapScore;

  const rationale = buildRationale(sb, c, {
    crScore, hpScore, acScore, sizeScore, abilityScore,
    traitOverlapScore, actionOverlapScore, sbTraitNames, sbActionNames,
  });

  return {
    overall,
    components: {
      crDelta: crScore,
      hpDelta: hpScore,
      acDelta: acScore,
      sizeMatch: sizeScore,
      abilityCosine: abilityScore,
      traitOverlap: traitOverlapScore,
      actionOverlap: actionOverlapScore,
    },
    rationale,
  };
}

function crProximity(a: number, b: number): number {
  // Within 0: 1.0; within 1: 0.7; within 2: 0.35; beyond: already filtered.
  const delta = Math.abs(a - b);
  if (delta === 0) return 1.0;
  if (delta <= 1) return 0.7;
  if (delta <= 2) return 0.35;
  return 0;
}

function hpProximity(reloadedHp: number, candidateHp: number): number {
  // Ratio-based: 1.0 at equality, linear decay to 0 at ±50%.
  const ratio = Math.abs(candidateHp - reloadedHp) / Math.max(reloadedHp, 1);
  return Math.max(0, 1 - 2 * ratio);
}

function acProximity(a: number, b: number): number {
  // 1.0 at equality, -0.2 per AC point, floor at 0.
  return Math.max(0, 1 - 0.2 * Math.abs(a - b));
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface RationaleInputs {
  crScore: number;
  hpScore: number;
  acScore: number;
  sizeScore: number;
  abilityScore: number;
  traitOverlapScore: number;
  actionOverlapScore: number;
  sbTraitNames: Set<string>;
  sbActionNames: Set<string>;
}

function buildRationale(sb: ReloadedStatblock, c: CandidateFull, s: RationaleInputs): string[] {
  const out: string[] = [];

  if (c.cr !== null && sb.challengeNumeric !== null) {
    if (s.crScore === 1.0) out.push(`CR ${c.cr} matches exactly`);
    else out.push(`CR ${c.cr} vs ${sb.challengeNumeric} (Δ${Math.abs(c.cr - sb.challengeNumeric).toFixed(1)})`);
  }

  if (c.hp !== null) {
    const d = Math.abs(c.hp - sb.hp.avg);
    if (d === 0) out.push(`HP ${c.hp} matches exactly`);
    else out.push(`HP ${c.hp} vs ${sb.hp.avg} (Δ${d})`);
  }

  const sharedTraits = [...s.sbTraitNames].filter(n => c.featNames.has(n));
  if (sharedTraits.length > 0) {
    out.push(`shares ${sharedTraits.length}/${s.sbTraitNames.size} trait(s): ${sharedTraits.slice(0, 4).join(', ')}${sharedTraits.length > 4 ? '…' : ''}`);
  }

  const sharedActions = [...s.sbActionNames].filter(n => c.itemNames.has(n));
  if (sharedActions.length > 0) {
    out.push(`shares ${sharedActions.length}/${s.sbActionNames.size} action(s): ${sharedActions.slice(0, 4).join(', ')}${sharedActions.length > 4 ? '…' : ''}`);
  }

  out.push(`ability cosine ${s.abilityScore.toFixed(2)}`);

  return out;
}
