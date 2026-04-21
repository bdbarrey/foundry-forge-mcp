// Pure scoring functions for infer-base-action (Phase 3b).
//
// Given a parsed Reloaded action (name + ParsedAction combat data) and a
// compendium Item candidate (weapon / consumable / spell / feat), produce a
// 0..1 similarity score + breakdown and a short rationale.
//
// Heuristic priorities:
//   1. Name match dominates (0.45 weight) — action names carry strong signal
//      ("Thunderstone" → Thunderstone, "Dagger" → Dagger). This is different
//      from monster-base inference where traits carried the signal.
//   2. Category match (attack vs. save) — if action and candidate disagree
//      on having an attack activity, they're probably the wrong pair.
//   3. Damage type overlap — "Alchemist's Firebomb" (fire) vs "Alchemist's
//      Fire" (fire) confirms the match beyond just name.
//   4. Save-ability overlap — for save-type actions. Often absent on SRD
//      candidates since dnd5e 4.x derives save ability at roll time, so this
//      weight stays low.
//   5. Damage magnitude proximity — 1d4 vs 2d6 dice totals. Minor tiebreaker.

import type { ParsedAction } from '../parsers/action-description.js';

export interface ActionCandidateBasic {
  packId: string;
  itemId: string;
  name: string;
  /** 'weapon' | 'consumable' | 'spell' | 'feat' | 'equipment' */
  type: string;
}

export interface ActionCandidateFull extends ActionCandidateBasic {
  /** Activity types on this item: 'attack', 'save', 'damage', 'utility', ... */
  activityTypes: Set<string>;
  /** Union of damage types declared across all activities' damage parts. */
  damageTypes: Set<string>;
  /** Union of save abilities (if any activity has a save config). Usually empty for SRD. */
  saveAbilities: Set<string>;
  /** Sum of damage dice "average" across all activities. Rough magnitude proxy. */
  damageMagnitude: number;
  /** Range in feet from the primary activity (reach for melee, value for ranged). */
  range: number | null;
}

export interface ActionScoreBreakdown {
  overall: number;
  components: {
    nameMatch: number;
    categoryMatch: number;
    damageTypeMatch: number;
    saveAbilityMatch: number;
    damageMagnitudeMatch: number;
  };
  rationale: string[];
}

const WEIGHTS = {
  nameMatch: 0.45,
  categoryMatch: 0.25,
  damageTypeMatch: 0.15,
  saveAbilityMatch: 0.10,
  damageMagnitudeMatch: 0.05,
} as const;

/** Below this, we scratch-build instead of copy-patching. */
export const ACTION_CONFIDENCE_FLOOR = 0.45;

/** Strip usage-marker parentheticals: "Tanglefoot (1/day)" → "tanglefoot". */
export function normalizeActionName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

/** Yield search-query variants for an action name, from most specific to most generic. */
export function* actionNameVariants(name: string): Generator<string> {
  const normalized = normalizeActionName(name);
  yield normalized;

  // Single-word stems for multi-word actions: "Hail of Daggers" → "dagger".
  // Try stripping leading qualifiers ("Hail of", "Alchemist's").
  const tokens = normalized.split(/\s+/);
  if (tokens.length > 1) {
    // Last token (often the weapon/thing name).
    const last = tokens[tokens.length - 1].replace(/s$/, '');
    if (last.length >= 4) yield last;
    // Second-to-last if last was a generic suffix like "bomb" → "firebomb".
    if (tokens.length > 2) {
      const joined = tokens.slice(-2).join(' ').replace(/s$/, '');
      if (joined !== normalized) yield joined;
    }
  }

  // Common Reloaded → SRD mappings. Reloaded loves to put "'s" possessives.
  // "Alchemist's Firebomb" → "alchemist's fire" (SRD item).
  if (normalized.includes("firebomb")) yield "alchemist's fire";
  if (normalized.includes("hail of daggers")) yield "dagger";
}

export function passesHardFilters(_action: ParsedAction, c: ActionCandidateBasic): boolean {
  if (!c.name || !c.itemId || !c.packId) return false;
  // Never match against things that can't be an action item:
  // - type='spell' is OK (monster features can mirror spells)
  // - type='weapon'/'consumable'/'equipment'/'feat' are OK
  // - type='class'/'race'/'background'/'subclass' are metadata, not actions
  const disallowed = new Set(['class', 'subclass', 'race', 'background', 'tool']);
  if (disallowed.has(c.type)) return false;
  return true;
}

export function scoreActionCandidate(
  action: ParsedAction,
  c: ActionCandidateFull,
  actionName: string,
): ActionScoreBreakdown {
  const nameScore = computeNameScore(actionName, c.name);
  const categoryScore = computeCategoryScore(action, c);
  const damageTypeScore = computeDamageTypeScore(action, c);
  const saveAbilityScore = computeSaveAbilityScore(action, c);
  const magnitudeScore = computeMagnitudeScore(action, c);

  const overall =
    WEIGHTS.nameMatch * nameScore +
    WEIGHTS.categoryMatch * categoryScore +
    WEIGHTS.damageTypeMatch * damageTypeScore +
    WEIGHTS.saveAbilityMatch * saveAbilityScore +
    WEIGHTS.damageMagnitudeMatch * magnitudeScore;

  const rationale: string[] = [];
  if (nameScore === 1.0) rationale.push(`exact name match`);
  else if (nameScore >= 0.7) rationale.push(`partial name match (${nameScore.toFixed(2)})`);
  if (categoryScore === 1.0) {
    rationale.push(`category matches (${action.attackBonus !== undefined ? 'attack' : action.save ? 'save' : 'utility'})`);
  } else if (categoryScore < 0.5) {
    rationale.push(`category mismatch`);
  }
  if (damageTypeScore > 0) {
    const overlap = [...c.damageTypes].filter(t => action.damage.some(d => d.type.toLowerCase() === t));
    if (overlap.length > 0) rationale.push(`shares damage: ${overlap.join(', ')}`);
  }

  return {
    overall,
    components: {
      nameMatch: nameScore,
      categoryMatch: categoryScore,
      damageTypeMatch: damageTypeScore,
      saveAbilityMatch: saveAbilityScore,
      damageMagnitudeMatch: magnitudeScore,
    },
    rationale,
  };
}

function computeNameScore(actionName: string, candidateName: string): number {
  const a = normalizeActionName(actionName);
  const b = candidateName.toLowerCase().trim();
  if (a === b) return 1.0;
  if (b.includes(a)) return 0.85;   // "Dagger" is a substring of "Dagger, +1" etc
  if (a.includes(b)) return 0.75;   // "Hail of Daggers" contains "dagger"
  // Token overlap
  const aTokens = new Set(a.split(/\s+/).filter(t => t.length >= 3));
  const bTokens = new Set(b.split(/\s+/).filter(t => t.length >= 3));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of aTokens) if (bTokens.has(t)) overlap++;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function computeCategoryScore(action: ParsedAction, c: ActionCandidateFull): number {
  const actionIsAttack = action.attackBonus !== undefined;
  const actionIsSave = !!action.save;
  const candHasAttack = c.activityTypes.has('attack');
  const candHasSave = c.activityTypes.has('save');
  // Most Reloaded items like Alchemist's Firebomb have BOTH (attack roll +
  // save for splash) — candidate also often has both. Match if ANY overlap.
  if (actionIsAttack && candHasAttack) return 1.0;
  if (actionIsSave && candHasSave) return 1.0;
  // Action has no attack/save at all (pure utility) — anything scores 0.5.
  if (!actionIsAttack && !actionIsSave) return 0.5;
  // Candidate has no activities — weak signal, don't penalize too hard.
  if (c.activityTypes.size === 0) return 0.5;
  // Clear mismatch (e.g. action is save-only but candidate is attack-only).
  return 0.2;
}

function computeDamageTypeScore(action: ParsedAction, c: ActionCandidateFull): number {
  const actionTypes = new Set(
    action.damage.map(d => (d.type ?? '').toLowerCase()).filter(Boolean),
  );
  if (actionTypes.size === 0 || c.damageTypes.size === 0) return 0;
  let overlap = 0;
  for (const t of actionTypes) if (c.damageTypes.has(t)) overlap++;
  return overlap / Math.max(actionTypes.size, c.damageTypes.size);
}

function computeSaveAbilityScore(action: ParsedAction, c: ActionCandidateFull): number {
  if (!action.save?.ability) return 0;
  if (c.saveAbilities.size === 0) return 0;
  return c.saveAbilities.has(action.save.ability.toLowerCase()) ? 1.0 : 0;
}

function computeMagnitudeScore(action: ParsedAction, c: ActionCandidateFull): number {
  const actionAvg = averageDamageFromParsed(action);
  if (actionAvg === 0 || c.damageMagnitude === 0) return 0.5;   // neutral
  const ratio = Math.abs(actionAvg - c.damageMagnitude) / Math.max(actionAvg, c.damageMagnitude);
  return Math.max(0, 1 - ratio);
}

/** Approximate average damage for a ParsedAction from its damage parts. */
function averageDamageFromParsed(action: ParsedAction): number {
  let total = 0;
  for (const part of action.damage) {
    total += averageDamageFromFormula(part.formula);
  }
  return total;
}

/** "2d8 + 4" → 13. Best-effort; ignores weird syntax. */
function averageDamageFromFormula(formula: string): number {
  let sum = 0;
  const diceMatch = formula.matchAll(/(\d+)\s*d\s*(\d+)/g);
  for (const m of diceMatch) {
    const n = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (!isNaN(n) && !isNaN(d)) sum += n * (d + 1) / 2;
  }
  const flatMatch = formula.match(/([+-]\s*\d+)(?!\s*d)/g);
  if (flatMatch) {
    for (const f of flatMatch) {
      sum += parseInt(f.replace(/\s+/g, ''), 10);
    }
  }
  return sum;
}
