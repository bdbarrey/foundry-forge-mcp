// Parse structured combat data out of a D&D 5e action description as it
// appears on a Reloaded statblock. Pure functions; no Foundry dependency.
//
// Input: plain-text description (post-HTML-strip) of a single action/feature.
//   e.g. "Melee Weapon Attack: +7 to hit, reach 5 ft., one target. Hit:
//         13 (2d8 + 4) slashing damage, or 15 (2d10 + 4) slashing damage
//         if used with two hands."
// Output: ParsedAction with whatever fields the parser could recognize.
//   Unrecognized prose stays in the caller's `description` field untouched.

export type AttackType = 'melee' | 'ranged';
export type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

/**
 * dnd5e 2024 / Foundry condition statuses recognized by the parser. When a
 * Reloaded action prose says "or be restrained until ...", the parser emits a
 * ParsedAction.condition that the build pipeline wires into a Midi save-link
 * (activity.effects[] + item active effect with statuses[]). Mirrors Foundry's
 * native condition system so the Foundry status icon lights up on save fail.
 */
export type ConditionType =
  | 'blinded'
  | 'charmed'
  | 'deafened'
  | 'frightened'
  | 'grappled'
  | 'incapacitated'
  | 'paralyzed'
  | 'petrified'
  | 'poisoned'
  | 'prone'
  | 'restrained'
  | 'stunned'
  | 'unconscious';

/**
 * Parsed duration for a condition application. `rounds` is the combat-rounds
 * count (10 rounds = 1 minute in 5e). `specialDuration` (DAE-style) handles
 * "until end/start of next turn" patterns precisely — mapped to Foundry's
 * Times-Up specialDuration tags at build time.
 */
export interface ParsedConditionDuration {
  /** Combat rounds. 1 = "until end of next turn", 10 = "1 minute". */
  rounds?: number;
  /** Wall-clock seconds. 60 = "1 minute", 3600 = "1 hour". Mirrors rounds. */
  seconds?: number;
  /**
   * DAE / Times-Up specialDuration tag. "turnEnd" = end of source's next turn,
   * "turnStart" = start of source's next turn, "turnEndSource" / "turnStartSource"
   * = ends at the end/start of the source creature's turn.
   */
  specialDuration?: 'turnEnd' | 'turnStart' | 'turnEndSource' | 'turnStartSource';
}

/**
 * "A target can repeat the saving throw at the end of each of its turns,
 * ending the effect on a success." pattern. When set, the build pipeline
 * writes a Midi-QOL OverTime flag on the condition effect so Midi prompts
 * the target for a save at the end of their turn each round and removes
 * the effect on success — matching Reloaded's "until break free" mechanic.
 */
export interface ParsedRepeatSave {
  /** When the save fires. "turnEnd" = end of target's turn (5e default). */
  period: 'turnEnd' | 'turnStart';
  /**
   * Save ability + DC for the repeat check. Default: same as the parent
   * action's primary save (Tanglefoot's repeat-save is also DC 14 STR).
   */
  ability: AbilityKey;
  dc: number;
}

export interface ParsedCondition {
  type: ConditionType;
  duration?: ParsedConditionDuration;
  /**
   * Repeat-save mechanism (Reloaded "ending the effect on a success" prose).
   * When set, the effect is INDEFINITE (no fixed duration); Midi removes it
   * automatically on a successful repeat save. Mutually exclusive with
   * `duration` for canonical-pattern-correctness — if duration is also set,
   * the effect would expire either way (whichever fires first).
   */
  repeatSave?: ParsedRepeatSave;
}

/**
 * Area template shapes recognized by dnd5e activity targeting. Maps directly to
 * `target.template.type` on dnd5e activities. "circle" = 5e radius, "sphere" =
 * 3D radius (rare, mostly clouds/fog), "cylinder" = vertical column.
 */
export type TemplateShape = 'circle' | 'cone' | 'line' | 'cube' | 'sphere' | 'cylinder';

export interface ParsedTargetTemplate {
  shape: TemplateShape;
  /** Size in feet — radius for circle/sphere, length for cone/line/cube. */
  size: number;
  /** Optional width in feet (lines only; dnd5e default is 5). */
  width?: number;
}

export interface ParsedTargetAffects {
  /**
   * Target category. "creature" matches any creature; "enemy"/"ally" used
   * when the prose explicitly limits ("each enemy creature within...").
   */
  type: 'creature' | 'enemy' | 'ally' | 'object' | 'self' | 'space';
  /**
   * Specific target count when prose enumerates ("up to two creatures",
   * "one target"). Omit for "each creature in the area" patterns where the
   * template defines the count.
   */
  count?: number;
  /**
   * True when the caster picks WHICH targets are affected (e.g. "up to two
   * creatures of your choice"). False/undefined for "each creature in area".
   */
  choice?: boolean;
}

/**
 * Parsed targeting shape from action prose. Drives Phase 10A.7 activity-side
 * `target.template` + `target.affects` writes so Midi prompts for the right
 * template (circle/cone/etc.) and auto-targets tokens inside it. Without this,
 * Tanglefoot's "10-foot radius" prose gets lost — the activity ends up as a
 * single-creature target and the GM has to manually draw a template.
 */
export interface ParsedTargetShape {
  template?: ParsedTargetTemplate;
  affects?: ParsedTargetAffects;
}

export interface DamagePart {
  /** Dice formula as printed, e.g. "2d8 + 4" or "4d6". */
  formula: string;
  /** Damage type, lowercased ("slashing", "necrotic", "poison", ...). */
  type: string;
}

export interface ParsedAction {
  attackType?: AttackType;
  /** Numeric attack bonus, e.g. +7 → 7. */
  attackBonus?: number;
  /** Melee reach in feet. */
  reach?: number;
  /** Ranged normal/long in feet. */
  range?: { normal: number; long?: number };
  /** "one target", "one creature", "each creature in a 30-foot-radius sphere", etc. */
  target?: string;
  /** Primary damage parts. Multiple entries for "plus X damage" chains. */
  damage: DamagePart[];
  /** Secondary damage for versatile weapons ("or ... if used with two hands"). */
  versatile?: DamagePart;
  /** Primary save the target makes (if any). */
  save?: { dc: number; ability: AbilityKey; onSuccess?: 'half' };
  /**
   * Condition applied on save fail (Tanglefoot → restrained, Smokestick →
   * blinded inside the area, Crushing Blow → prone). When set, the build
   * pipeline emits an active effect on the item with `statuses: [type]` and
   * links it from the save activity's `effects[]` so Midi auto-applies the
   * Foundry condition on a failed save.
   */
  condition?: ParsedCondition;
  /**
   * Targeting shape: area template (radius/cone/line/etc.) and/or affected
   * target type/count. When set, Phase 10A.7 build path writes
   * `target.template` + `target.affects` so Midi prompts for the right
   * template and auto-targets the tokens inside.
   */
  targetShape?: ParsedTargetShape;
  /** Usage limit like "(1/Day)", "(Recharge 5-6)". */
  usage?:
    | { count: number; period: 'day' | 'long-rest' | 'short-rest' | 'turn' }
    | { recharge: [number, number] };
}

const ABILITY_NAMES: Record<string, AbilityKey> = {
  strength: 'str', str: 'str',
  dexterity: 'dex', dex: 'dex',
  constitution: 'con', con: 'con',
  intelligence: 'int', int: 'int',
  wisdom: 'wis', wis: 'wis',
  charisma: 'cha', cha: 'cha',
};

/**
 * Parse a single action description string. Returns null only for entirely
 * empty input — otherwise returns a ParsedAction with whatever could be
 * recognized (fields may be absent).
 */
export function parseActionDescription(desc: string): ParsedAction | null {
  if (!desc || !desc.trim()) return null;

  // Normalize whitespace and fancy quotes/dashes so regexes are simpler.
  const text = desc
    .replace(/ | | /g, ' ')      // various spaces → plain
    .replace(/[‐-―−]/g, '-')                     // dashes/minus → hyphen
    .replace(/[‘’]/g, "'")                        // curly → straight
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  const out: ParsedAction = { damage: [] };

  // Attack type + bonus
  //   "Melee Weapon Attack: +7 to hit"  (5e 2014)
  //   "Melee Attack Roll: +7"           (5e 2024)
  //   "Melee Weapon Attack +7 to hit"   (Reloaded sometimes drops the colon
  //                                      — Volenta's Dagger entry, for one)
  const attackMatch = text.match(
    /(Melee|Ranged)\s+(?:Weapon\s+)?Attack(?:\s+Roll)?\s*[:,]?\s*([+-]?\d+)\s*(?:to hit)?/i,
  );
  if (attackMatch) {
    out.attackType = attackMatch[1].toLowerCase() as AttackType;
    out.attackBonus = parseInt(attackMatch[2], 10);
  }

  // Reach (melee)
  const reachMatch = text.match(/reach\s+(\d+)\s*ft\.?/i);
  if (reachMatch) out.reach = parseInt(reachMatch[1], 10);

  // Range (ranged) — "range 150/600 ft." or "range 30 ft."
  const rangeMatch = text.match(/range\s+(\d+)(?:\s*\/\s*(\d+))?\s*ft\.?/i);
  if (rangeMatch) {
    const normal = parseInt(rangeMatch[1], 10);
    out.range = rangeMatch[2]
      ? { normal, long: parseInt(rangeMatch[2], 10) }
      : { normal };
  }

  // Bare-distance reach fallback: Reloaded sometimes drops the "reach" keyword
  // ("Melee Weapon Attack +7 to hit, 5 ft., one target." — Volenta's Dagger).
  // Only use as fallback for melee attacks when explicit reach didn't match.
  if (out.reach === undefined && out.attackType === 'melee') {
    const bareReach = text.match(/Attack(?:\s+Roll)?[^.]*?,\s*(\d+)\s*ft\.?\s*,/i);
    if (bareReach) out.reach = parseInt(bareReach[1], 10);
  }

  // Prose range/area fallback for save-only AoEs (Volenta's Tanglefoot,
  // Thunderstone, Firebomb, Smokestick). Only fires when the explicit
  // "range X ft." pattern didn't match. Pulls the FIRST distance qualifier
  // attached to the action — "within 30 feet" / "10-foot radius" / "X-foot
  // cone" / "X-foot line". Caster-relative distance ("within 5 feet of one
  // another", "within 5 feet of a hostile creature") is skipped: it describes
  // target relationships, not the action's range.
  if (!out.range) {
    const proseDistance =
      text.match(/within\s+(\d+)\s*(?:feet|ft\.?)(?!\s+of)/i) ??
      text.match(/(\d+)-foot\s+(?:radius|cone|line|cube|sphere)/i);
    if (proseDistance) {
      out.range = { normal: parseInt(proseDistance[1], 10) };
    }
  }

  // Target — everything between reach/range and the terminating period, or
  // before "Hit:".
  const targetMatch = text.match(
    /(?:reach\s+\d+\s*ft\.?|range\s+\d+(?:\s*\/\s*\d+)?\s*ft\.?)\s*,\s*([^.]+?)\s*\.\s*(?:Hit:|$)/i,
  );
  if (targetMatch) out.target = targetMatch[1].trim();

  // Damage parts. Parse everything after "Hit:" (or the whole text for
  // save-only abilities) looking for "N (NdN ± M) <type> damage".
  const hitSplit = text.split(/\bHit\s*:\s*/i);
  const damageScope = hitSplit.length > 1 ? hitSplit[1] : text;

  // Split damage area into primary and versatile segments.
  // Versatile = "... or NdN ... damage if used with two hands" or
  //             "... or NdN ... damage if wielded with two hands".
  let primaryText = damageScope;
  let versatileText: string | null = null;
  const versatileMatch = damageScope.match(
    /,?\s*or\s+(\d+\s*\(([^)]+)\)\s*[a-z]+\s*damage)\s*(?:if\s+(?:used|wielded)\s+with\s+two\s+hands|when\s+wielded\s+with\s+two\s+hands)/i,
  );
  if (versatileMatch) {
    primaryText = damageScope.slice(0, versatileMatch.index);
    versatileText = versatileMatch[1];
  }

  for (const m of matchDamageParts(primaryText)) {
    out.damage.push(m);
  }
  if (versatileText) {
    const parts = [...matchDamageParts(versatileText)];
    if (parts.length > 0) out.versatile = parts[0];
  }

  // Save: "DC <N> <Ability> saving throw"
  const saveMatch = text.match(
    /DC\s+(\d+)\s+(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma|Str|Dex|Con|Int|Wis|Cha)\s+saving\s+throw/i,
  );
  if (saveMatch) {
    const ability = ABILITY_NAMES[saveMatch[2].toLowerCase()];
    if (ability) {
      out.save = { dc: parseInt(saveMatch[1], 10), ability };
      if (/half\s+(?:as much|damage)/i.test(text)) out.save.onSuccess = 'half';
    }
  }

  // Condition applied on save-fail. Only attached when the action also has a
  // save — a bare "X is restrained" without a save is descriptive prose, not
  // an automatable application. Order matches the ConditionType union; the
  // first match wins (longest/most-specific synonyms first, e.g. "knocked
  // prone" before "prone").
  if (out.save) {
    const condition = parseCondition(text, out.save);
    if (condition) out.condition = condition;
  }

  // Targeting shape — area template + affects count. Detected from prose like
  // "10-foot radius", "60-foot cone", "each creature in the area", "up to two
  // creatures". Independent of `range` (which is the throw distance to the
  // target POINT). Tanglefoot has BOTH: range=30 (throw distance) +
  // template.circle/10 (radius around the impact point).
  const targetShape = parseTargetShape(text, out);
  if (targetShape.template || targetShape.affects) {
    out.targetShape = targetShape;
  }

  // Usage — printed in parens on the feature NAME or at the start of the
  // description. Reloaded puts them in the name (e.g. "Virulent Miasma
  // (1/Day)") — the caller can pass that name-parenthetical text in.
  const usage = parseUsageMarker(text);
  if (usage) out.usage = usage;

  // If we recognized nothing, we still return the shape (with empty damage).
  // Callers can decide whether to treat that as "not an action".
  return out;
}

/**
 * Extract a usage marker from an action's NAME parenthetical or description.
 * Recognizes "1/Day", "3/Day", "Recharge 5-6", "Recharges after a Long Rest".
 */
export function parseUsageMarker(text: string): ParsedAction['usage'] | undefined {
  const perDay = text.match(/\((\d+)\s*\/\s*Day\)/i);
  if (perDay) return { count: parseInt(perDay[1], 10), period: 'day' };

  const recharge = text.match(/\(Recharge\s+(\d+)\s*-\s*(\d+)\)/i);
  if (recharge) return { recharge: [parseInt(recharge[1], 10), parseInt(recharge[2], 10)] };

  if (/recharges?\s+after\s+a\s+long\s+rest/i.test(text)) {
    return { count: 1, period: 'long-rest' };
  }
  if (/recharges?\s+after\s+a\s+short\s+or\s+long\s+rest|short\s+rest/i.test(text)) {
    return { count: 1, period: 'short-rest' };
  }
  return undefined;
}

/**
 * Walk a damage-scope string yielding each "N (formula) <type> damage" part.
 * Recognizes chained damages joined by " plus ".
 */
function* matchDamageParts(scope: string): Generator<DamagePart> {
  // "10 (2d6 + 3) necrotic damage", "14 (4d6) poison damage"
  const re = /\d+\s*\(([^)]+)\)\s*([a-z]+(?:\s+or\s+[a-z]+)?)\s*damage/gi;
  let m: RegExpExecArray | null;
  let found = 0;
  while ((m = re.exec(scope)) !== null) {
    found++;
    yield { formula: normalizeFormula(m[1]), type: m[2].toLowerCase().trim() };
  }
  if (found > 0) return;

  // Fallback for save-or-damage prose that omits the printed average and parens
  // (Volenta's Firebomb: "must succeed on a DC 14 Dexterity saving throw or
  // take 2d6 fire damage"). Anchored to "or take" / "saving throw, taking" so
  // we don't pick up secondary/ongoing effects further down the description
  // (e.g. "1d4 fire damage at the start of each of its turns").
  const re2 =
    /(?:\bor\s+(?:take|takes)\s+|saving throw,?\s+(?:taking|takes)\s+)(\d+d\d+(?:\s*[+-]\s*\d+)?)\s+([a-z]+(?:\s+or\s+[a-z]+)?)\s+damage/gi;
  while ((m = re2.exec(scope)) !== null) {
    yield { formula: normalizeFormula(m[1]), type: m[2].toLowerCase().trim() };
  }
}

function normalizeFormula(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Word-form numbers used in prose like "up to two creatures". Limited to small
 * integers — anything past five tends to be written as digits ("up to 6").
 */
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10,
};

/**
 * Parse area template + affects count from action prose. Caller passes the
 * already-parsed action so we can disambiguate (e.g. melee attacks default to
 * single-creature target without needing prose to say so explicitly).
 */
function parseTargetShape(text: string, parsed: ParsedAction): ParsedTargetShape {
  const out: ParsedTargetShape = {};

  // Template shape — "X-foot radius/sphere/cone/line/cube/cylinder". A circle
  // shape covers both "radius" (5e default 2D) and "sphere" (3D) — dnd5e
  // distinguishes them at the template-renderer level. We map "radius" to
  // circle (most common at-the-table) and "sphere" to sphere when explicit.
  const templateMatch =
    text.match(/(\d+)-foot\s+(radius|sphere|cone|line|cube|cylinder)/i) ??
    text.match(/(\d+)\s*ft\.?\s+(radius|sphere|cone|line|cube|cylinder)/i);
  if (templateMatch) {
    const size = parseInt(templateMatch[1], 10);
    const word = templateMatch[2].toLowerCase();
    const shape: TemplateShape = word === 'radius' ? 'circle' : (word as TemplateShape);
    out.template = { shape, size };
    // Lines have an implicit width — "60-foot line" is 5ft wide by default.
    // Reloaded sometimes specifies "X feet wide" explicitly; pick that up.
    if (shape === 'line') {
      const widthMatch = text.match(/(\d+)\s*(?:feet|ft\.?)\s+wide/i);
      out.template.width = widthMatch ? parseInt(widthMatch[1], 10) : 5;
    }
  }

  // (Reverted Phase 10C.2 attempt at implicit-circle parsing — "within X
  // feet of point/impact/etc." prose. Decision 2026-04-29: regex-extending
  // the parser per Reloaded prose variant doesn't scale. Pivoting to LLM-
  // driven build interpretation; see reference_create_actor_option3_handoff.md
  // for the design.)

  // Affects count — "up to N creatures", "up to N targets", "one creature",
  // "each creature in (the area|that area)". Word-form (one/two/three) and
  // digit-form both supported.
  const upToWord = text.match(/up\s+to\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+(creatures?|targets?|enem(?:y|ies))/i);
  const upToDigit = text.match(/up\s+to\s+(\d+)\s+(creatures?|targets?|enem(?:y|ies))/i);
  if (upToWord) {
    out.affects = {
      type: /enem/i.test(upToWord[2]) ? 'enemy' : 'creature',
      count: WORD_NUMBERS[upToWord[1].toLowerCase()],
      choice: true,
    };
  } else if (upToDigit) {
    out.affects = {
      type: /enem/i.test(upToDigit[2]) ? 'enemy' : 'creature',
      count: parseInt(upToDigit[1], 10),
      choice: true,
    };
  } else if (/each\s+(?:creature|enemy|ally|target)\s+(?:in\s+(?:the|that)\s+area|within)/i.test(text)) {
    // "each creature in the area" — all targets inside template, no count cap.
    const enemyOnly = /each\s+enemy/i.test(text);
    const allyOnly = /each\s+ally/i.test(text);
    out.affects = {
      type: enemyOnly ? 'enemy' : (allyOnly ? 'ally' : 'creature'),
    };
  } else if (/\bone\s+(?:creature|target|enemy)\b/i.test(text) && !out.template) {
    // Single-target action ("one creature"). Skip when a template was found —
    // template-shaped actions describe their targets via "each creature in area".
    out.affects = { type: 'creature', count: 1 };
  } else if (parsed.attackBonus !== undefined && !out.template) {
    // Attack rolls without explicit prose default to single creature (Bite,
    // Longsword, etc.). Save-only actions without prose stay null — the parser
    // can't infer single-vs-area without a template or wording cue.
    out.affects = { type: 'creature', count: 1 };
  }

  return out;
}

/**
 * Patterns that resolve to a Foundry condition status. Ordered: longest /
 * most-specific synonyms first so "knocked prone" matches before bare "prone",
 * and "frightened of" before "frightened". Each pattern is evaluated against
 * the post-save scope of the description (the prose introducing the save's
 * consequences), not the whole text.
 */
const CONDITION_PATTERNS: Array<{ regex: RegExp; type: ConditionType }> = [
  { regex: /knocked\s+prone|fall(?:s)?\s+prone|falls?\s+prone\b/i, type: 'prone' },
  { regex: /\bbe\s+(?:left\s+)?paralyzed\b/i, type: 'paralyzed' },
  { regex: /\bbe\s+(?:left\s+)?petrified\b/i, type: 'petrified' },
  { regex: /\bbe\s+(?:left\s+)?stunned\b/i, type: 'stunned' },
  { regex: /\bbe\s+(?:left\s+)?incapacitated\b/i, type: 'incapacitated' },
  { regex: /\bbe\s+(?:left\s+)?unconscious\b/i, type: 'unconscious' },
  { regex: /\bbe\s+(?:left\s+)?(?:magically\s+)?frightened\b/i, type: 'frightened' },
  { regex: /\bbe\s+(?:left\s+)?(?:magically\s+)?charmed\b/i, type: 'charmed' },
  { regex: /\bbe\s+(?:left\s+)?(?:magically\s+)?restrained\b/i, type: 'restrained' },
  { regex: /\bbe\s+(?:left\s+)?(?:magically\s+)?grappled\b/i, type: 'grappled' },
  { regex: /\bbe\s+(?:left\s+)?blinded\b/i, type: 'blinded' },
  { regex: /\bbe\s+(?:left\s+)?deafened\b/i, type: 'deafened' },
  { regex: /\bbe\s+poisoned\b/i, type: 'poisoned' },
];

/**
 * Detect "or be <condition> [until/for ...]" clauses in action prose.
 * Anchors to the save context — caller has already verified `out.save` exists.
 *
 * Examples handled:
 *   "must succeed on a DC 14 Dex save or be restrained for 1 minute"
 *   "DC 13 Strength save or fall prone"
 *   "or be poisoned until the end of its next turn"
 *   "or be charmed for 24 hours"
 *   "or be restrained. A target can repeat the saving throw at the end of
 *    each of its turns, ending the effect on a success." (Tanglefoot)
 */
function parseCondition(
  text: string,
  parentSave: { dc: number; ability: AbilityKey },
): ParsedCondition | null {
  for (const { regex, type } of CONDITION_PATTERNS) {
    const m = text.match(regex);
    if (!m) continue;
    // Slice the prose AFTER the matched condition word so duration parsing
    // doesn't pick up unrelated durations elsewhere in the description.
    const tail = text.slice((m.index ?? 0) + m[0].length);
    const duration = parseConditionDuration(tail);
    const repeatSave = parseRepeatSave(tail, parentSave);
    const out: ParsedCondition = { type };
    if (duration) out.duration = duration;
    if (repeatSave) out.repeatSave = repeatSave;
    return out;
  }
  return null;
}

/**
 * Detect Reloaded's "A target can repeat the saving throw at the end of each
 * of its turns, ending the effect on a success" pattern. Returns the repeat-
 * save spec when matched (uses parent action's save DC + ability — the repeat
 * check is the same DC as the original).
 */
function parseRepeatSave(
  tail: string,
  parentSave: { dc: number; ability: AbilityKey },
): ParsedRepeatSave | undefined {
  // Common phrasings:
  //   "A target can repeat the saving throw at the end of each of its turns"
  //   "The target can repeat the save at the end of each of its turns"
  //   "Repeat the saving throw at the start of each of its turns"
  // Anchored to "at (the )?(end|start) of each of its turns" — the loose
  // wording ("can repeat the saving throw" vs "repeats", "save" vs "saving
  // throw") covers Reloaded's variants without false-positives on unrelated
  // prose like "at the end of its turn" (singular, one-shot).
  const m = tail.match(
    /repeats?\s+(?:the\s+)?sav(?:ing\s+throw|e)\s+at\s+(?:the\s+)?(end|start)\s+of\s+each\s+of\s+its\s+turns/i,
  );
  if (!m) return undefined;
  const period = m[1].toLowerCase() === 'start' ? 'turnStart' : 'turnEnd';
  return { period, ability: parentSave.ability, dc: parentSave.dc };
}

/**
 * Parse the duration tail after a condition word. Recognized:
 *   "until the end of <its | the target's | the creature's> next turn"  → 1 round + turnEnd
 *   "until the start of <its | ...> next turn"                           → 1 round + turnStart
 *   "for 1 minute"  → 10 rounds / 60 seconds
 *   "for 1 hour"    → 600 rounds / 3600 seconds
 *   "for N rounds"  → N rounds
 *   anything else   → undefined (caller leaves duration off the effect, lets
 *                     Times-Up rely on its defaults)
 */
function parseConditionDuration(tail: string): ParsedConditionDuration | undefined {
  // "until the end of its next turn" — most-common 5e cadence.
  if (/until\s+(?:the\s+)?end\s+of\s+(?:its|the\s+(?:target|creature|target's|creature's)|[a-z]+(?:'s)?)\s+next\s+turn/i.test(tail)) {
    return { rounds: 1, seconds: 6, specialDuration: 'turnEnd' };
  }
  if (/until\s+(?:the\s+)?start\s+of\s+(?:its|the\s+(?:target|creature|target's|creature's)|[a-z]+(?:'s)?)\s+next\s+turn/i.test(tail)) {
    return { rounds: 1, seconds: 6, specialDuration: 'turnStart' };
  }

  const minutes = tail.match(/for\s+(\d+)\s+minute/i);
  if (minutes) {
    const n = parseInt(minutes[1], 10);
    return { rounds: n * 10, seconds: n * 60 };
  }

  const hours = tail.match(/for\s+(\d+)\s+hour/i);
  if (hours) {
    const n = parseInt(hours[1], 10);
    return { rounds: n * 600, seconds: n * 3600 };
  }

  const rounds = tail.match(/for\s+(\d+)\s+rounds?/i);
  if (rounds) {
    const n = parseInt(rounds[1], 10);
    return { rounds: n, seconds: n * 6 };
  }

  return undefined;
}
