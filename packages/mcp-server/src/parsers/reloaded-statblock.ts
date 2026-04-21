// Reloaded statblock parser.
//
// Parses one `<div class="statblock">...</div>` block from CoS Reloaded markdown
// into a normalized JSON shape. Uses node-html-parser — a real HTML parser, not
// regex over <strong> tags.
//
// Output is oriented toward create-actor orchestration: downstream code diffs
// parsed stats against compendium bases and applies overrides (Phase 2+), or
// builds actors from scratch when no compendium match exists (Phase 6+).

import { parse, HTMLElement, Node, NodeType } from 'node-html-parser';

export interface StatblockAbility {
  score: number;
  mod: number;
}

export interface StatblockAbilities {
  str: StatblockAbility;
  dex: StatblockAbility;
  con: StatblockAbility;
  int: StatblockAbility;
  wis: StatblockAbility;
  cha: StatblockAbility;
}

export interface StatblockFeature {
  name: string;
  description: string;
}

export interface ReloadedStatblock {
  /** Raw <h2> text, e.g. "Zombie, Plague Spreader". */
  name: string;
  /** Medium / Small / Large / etc. */
  size: string;
  /** Creature type without the alignment ("Undead", "Humanoid (shapechanger)", ...). */
  type: string;
  /** Parenthetical subtype if present, e.g. "shapechanger". */
  subtype: string | null;
  /** Alignment trailing the creature type ("Neutral Evil", "LE", etc.). Empty string if absent. */
  alignment: string;

  ac: number;
  /** Parenthetical on AC if any, e.g. "natural armor". */
  acNote: string | null;

  hp: {
    avg: number;
    /** Dice expression (e.g. "3d8 + 9") if Reloaded provides it; null otherwise. */
    formula: string | null;
  };

  /** Raw "20 ft." / "40 ft., climb 40 ft." string. */
  speedText: string;
  /** Parsed speed modes: { walk, fly, climb, swim, burrow } → feet. */
  speed: Record<string, number>;

  abilities: StatblockAbilities;

  /** ability → bonus. Entries not listed on the statblock are absent. */
  saves: Record<string, number>;
  /** skill name (lowercased) → bonus. */
  skills: Record<string, number>;

  damageResistances: string | null;
  damageImmunities: string | null;
  damageVulnerabilities: string | null;
  conditionImmunities: string | null;

  sensesText: string;
  passivePerception: number | null;

  languages: string;

  /** Challenge Rating as printed ("1/4", "21", "21, or 19 when fought in sunlight"). */
  challenge: string;
  /** Numeric challenge where parseable; null for fractions like "1/4" → 0.25 is set, else null for odd strings. */
  challengeNumeric: number | null;

  proficiencyBonus: number | null;

  traits: StatblockFeature[];
  actions: StatblockFeature[];
  bonusActions: StatblockFeature[];
  reactions: StatblockFeature[];
  legendaryActions: StatblockFeature[];
  lairActions: StatblockFeature[];
}

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
type AbilityKey = typeof ABILITY_KEYS[number];

const SECTION_HEADINGS: Record<string, keyof Pick<ReloadedStatblock,
  'actions' | 'bonusActions' | 'reactions' | 'legendaryActions' | 'lairActions'>> = {
  'actions': 'actions',
  'bonus actions': 'bonusActions',
  'reactions': 'reactions',
  'legendary actions': 'legendaryActions',
  'lair actions': 'lairActions',
};

/**
 * Parse one Reloaded statblock from a markdown string.
 * Input may contain surrounding markdown; the first `div.statblock` is extracted.
 * Throws on malformed input.
 */
export function parseReloadedStatblock(markdown: string): ReloadedStatblock {
  const root = parse(markdown, { lowerCaseTagName: false });
  const sb = root.querySelector('div.statblock');
  if (!sb) {
    throw new Error('No <div class="statblock"> found in input');
  }

  const name = sb.querySelector('h2')?.text.trim() ?? '';
  if (!name) throw new Error('Statblock missing <h2> name');

  // First <em> holds "Size Type[ (subtype)], Alignment"
  const firstEm = sb.querySelector('em');
  const typeLine = firstEm ? cleanText(firstEm.text) : '';
  const { size, type, subtype, alignment } = parseTypeLine(typeLine);

  // Collect <strong>label</strong> → value pairs for the inline-labelled fields.
  // These appear throughout the statblock between <hr>s and inside <p>s (but we
  // restrict to direct children of the statblock div, so trait/action <p>s are
  // not scanned here).
  const labeledFields = collectLabeledFields(sb);

  // Armor Class
  const acRaw = requireField(labeledFields, 'Armor Class', name);
  const { value: ac, note: acNote } = parseAc(acRaw);

  // Hit Points
  const hpRaw = requireField(labeledFields, 'Hit Points', name);
  const hp = parseHp(hpRaw);

  // Speed
  const speedText = requireField(labeledFields, 'Speed', name);
  const speed = parseSpeed(speedText);

  // Ability scores
  const abilities = parseAbilityTable(sb, name);

  // Optional middle-block fields
  const saves = labeledFields.has('Saving Throws')
    ? parseBonusList(labeledFields.get('Saving Throws')!, 3 /* abbr length */)
    : {};
  const skills = labeledFields.has('Skills')
    ? parseBonusList(labeledFields.get('Skills')!)
    : {};

  const damageResistances = labeledFields.get('Damage Resistances') ?? null;
  const damageImmunities = labeledFields.get('Damage Immunities') ?? null;
  const damageVulnerabilities = labeledFields.get('Damage Vulnerabilities') ?? null;
  const conditionImmunities = labeledFields.get('Condition Immunities') ?? null;

  const sensesText = labeledFields.get('Senses') ?? '';
  const passivePerception = parsePassivePerception(sensesText);

  const languages = labeledFields.get('Languages') ?? '';
  const challenge = labeledFields.get('Challenge') ?? '';
  const challengeNumeric = parseChallenge(challenge);
  const proficiencyBonus = labeledFields.has('Proficiency Bonus')
    ? parseSignedInt(labeledFields.get('Proficiency Bonus')!)
    : null;

  // Traits + action-group sections, in document order.
  const { traits, sections } = parseFeatureSections(sb);

  return {
    name,
    size,
    type,
    subtype,
    alignment,
    ac,
    acNote,
    hp,
    speedText,
    speed,
    abilities,
    saves,
    skills,
    damageResistances,
    damageImmunities,
    damageVulnerabilities,
    conditionImmunities,
    sensesText,
    passivePerception,
    languages,
    challenge,
    challengeNumeric,
    proficiencyBonus,
    traits,
    actions: sections.actions ?? [],
    bonusActions: sections.bonusActions ?? [],
    reactions: sections.reactions ?? [],
    legendaryActions: sections.legendaryActions ?? [],
    lairActions: sections.lairActions ?? [],
  };
}

// ----- helpers --------------------------------------------------------------

/** Normalize whitespace + unicode minus-likes to ASCII for numeric parsing. */
function cleanText(s: string): string {
  return s
    .replace(/ | | /g, ' ') // various non-breaking / thin spaces
    .replace(/[‐-―−]/g, '-') // en-dash, em-dash, minus sign → hyphen
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTypeLine(line: string): {
  size: string;
  type: string;
  subtype: string | null;
  alignment: string;
} {
  // "Medium Undead, Neutral Evil"
  // "Medium undead (shapechanger), lawful evil"
  // "Medium Undead"                         ← alignment missing (Plague Spreader)
  const [left, ...rest] = line.split(',');
  const alignment = rest.join(',').trim();

  const trimmed = left.trim();
  // size = first word
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) {
    return { size: trimmed, type: '', subtype: null, alignment };
  }
  const size = trimmed.slice(0, firstSpace);
  let typePart = trimmed.slice(firstSpace + 1).trim();

  let subtype: string | null = null;
  const subMatch = typePart.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (subMatch) {
    typePart = subMatch[1].trim();
    subtype = subMatch[2].trim();
  }

  return { size, type: typePart, subtype, alignment };
}

/**
 * Walk direct children of the statblock, harvesting `<strong>LABEL</strong> VALUE`
 * pairs until we hit the first <h3> (which starts the action sections). Returns
 * a map keyed by the exact label text (without trailing punctuation).
 */
function collectLabeledFields(sb: HTMLElement): Map<string, string> {
  const fields = new Map<string, string>();
  const children = sb.childNodes;

  // Walk top-level nodes AND dive into <p> bodies (but not <h3>-following ones
  // because those are handled by parseFeatureSections). We stop scanning at the
  // first <h3>.
  for (const node of children) {
    if (isElement(node) && node.tagName === 'H3') break;
    harvestStrongLabels(node, fields, sb);
  }

  return fields;
}

/**
 * In the inline markup, a pattern like `<strong>Hit Points</strong> 22 (3d8 + 9) <br>`
 * is recognized by scanning sibling text/nodes after a <strong> until we hit the
 * next <strong>, <br>, or end of the container. We reuse this walker for both
 * statblock-direct children and <p>-wrapped content.
 */
function harvestStrongLabels(
  node: Node,
  out: Map<string, string>,
  _root: HTMLElement,
): void {
  if (!isElement(node)) return;

  // For <p> blocks in the header area (before <h3>), they sometimes wrap several
  // labelled fields on one line. Recurse into them.
  if (node.tagName === 'P') {
    for (const child of node.childNodes) {
      harvestStrongLabels(child, out, _root);
    }
    return;
  }

  // Treat the entire run of children at THIS level; find <strong> starts and
  // collect subsequent text until next stopper.
  if (node.tagName !== 'STRONG') return;

  const rawLabel = cleanText(node.text).replace(/[.:]\s*$/, '');
  if (!rawLabel) return;

  // Gather trailing text + inline nodes until next <strong>/<br>.
  const siblings = node.parentNode?.childNodes ?? [];
  const idx = siblings.indexOf(node);
  const parts: string[] = [];
  for (let i = idx + 1; i < siblings.length; i++) {
    const sib = siblings[i];
    if (isElement(sib)) {
      const tag = sib.tagName;
      if (tag === 'STRONG' || tag === 'BR' || tag === 'HR' || tag === 'H3' || tag === 'TABLE') break;
      parts.push(sib.text);
    } else if (sib.nodeType === NodeType.TEXT_NODE) {
      parts.push(sib.rawText);
    }
  }

  const value = cleanText(parts.join(' '));
  if (value) out.set(rawLabel, value);
}

function requireField(fields: Map<string, string>, label: string, name: string): string {
  const v = fields.get(label);
  if (!v) throw new Error(`Statblock "${name}" missing required field: ${label}`);
  return v;
}

function parseAc(raw: string): { value: number; note: string | null } {
  const m = raw.match(/^(\d+)\s*(?:\(([^)]+)\))?\s*$/);
  if (!m) return { value: parseInt(raw, 10) || 0, note: null };
  return { value: parseInt(m[1], 10), note: m[2]?.trim() ?? null };
}

function parseHp(raw: string): { avg: number; formula: string | null } {
  const m = raw.match(/^(\d+)\s*(?:\(([^)]+)\))?\s*$/);
  if (!m) return { avg: parseInt(raw, 10) || 0, formula: null };
  return { avg: parseInt(m[1], 10), formula: m[2]?.trim() ?? null };
}

function parseSpeed(raw: string): Record<string, number> {
  const modes: Record<string, number> = {};
  // split on commas; each chunk looks like "20 ft." or "climb 40 ft."
  for (const chunk of raw.split(',').map(s => s.trim())) {
    const m = chunk.match(/^(?:(\w+)\s+)?(\d+)\s*ft/i);
    if (!m) continue;
    const mode = (m[1] ?? 'walk').toLowerCase();
    modes[mode] = parseInt(m[2], 10);
  }
  return modes;
}

function parseAbilityTable(sb: HTMLElement, name: string): StatblockAbilities {
  const row = sb.querySelector('table.ability-table tbody tr');
  if (!row) throw new Error(`Statblock "${name}" missing ability-table tbody row`);
  const cells = row.querySelectorAll('td');
  if (cells.length < 6) {
    throw new Error(`Statblock "${name}" ability-table has ${cells.length} cells (need 6)`);
  }

  const out: Partial<StatblockAbilities> = {};
  ABILITY_KEYS.forEach((key, i) => {
    const text = cleanText(cells[i].text);
    // "13 (+1)" or "6 (-2)" (after dash normalization)
    const m = text.match(/^(\d+)\s*\(\s*([+-]?\d+)\s*\)\s*$/);
    if (!m) throw new Error(`Statblock "${name}" ${key.toUpperCase()} cell unparseable: "${text}"`);
    out[key] = { score: parseInt(m[1], 10), mod: parseInt(m[2], 10) };
  });
  return out as StatblockAbilities;
}

/**
 * Parse a comma-separated bonus list like "Dex +12, Wis +9, Cha +12" or
 * "Arcana +19, Athletics +12". Returns { <key>: bonus }. Key is lowercased and
 * truncated to `abbrevLen` chars when supplied (for saves).
 */
function parseBonusList(raw: string, abbrevLen?: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of raw.split(',').map(s => cleanText(s))) {
    const m = entry.match(/^([A-Za-z][\w\s]*?)\s+([+-]?\d+)\s*$/);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    const key = abbrevLen ? label.slice(0, abbrevLen) : label;
    out[key] = parseInt(m[2], 10);
  }
  return out;
}

function parsePassivePerception(senses: string): number | null {
  const m = senses.match(/passive\s+perception\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseChallenge(raw: string): number | null {
  if (!raw) return null;
  // "1/4"
  const frac = raw.match(/^(\d+)\/(\d+)(?:\s|$)/);
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);
  // "21", "21, or 19 when fought in sunlight"
  const int = raw.match(/^(\d+)(?:\s|,|$)/);
  if (int) return parseInt(int[1], 10);
  return null;
}

function parseSignedInt(raw: string): number | null {
  const m = raw.match(/([+-]?\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Traits appear as <p>-wrapped features before the first <h3>. Each <h3>
 * begins a section ("Actions", "Bonus Actions", "Reactions", "Legendary
 * Actions", "Lair Actions") whose features run until the next <h3>.
 *
 * Walks all <h3>/<p> descendants in document order (not just direct children)
 * because Reloaded markdown occasionally contains unclosed <p> tags (e.g.
 * Strahd the Mage's "Dispel Magic" is missing its </p>, which causes HTML
 * parsers to nest the subsequent <h3>Bonus Actions</h3> inside the open <p>).
 * Document-order descent is robust to that; direct-child iteration is not.
 */
function parseFeatureSections(sb: HTMLElement): {
  traits: StatblockFeature[];
  sections: Partial<Record<keyof Pick<ReloadedStatblock,
    'actions' | 'bonusActions' | 'reactions' | 'legendaryActions' | 'lairActions'>,
    StatblockFeature[]>>;
} {
  const traits: StatblockFeature[] = [];
  const sections: Record<string, StatblockFeature[]> = {};
  let currentSectionKey: string | null = null;
  let seenFirstH3 = false;
  const seenPIds = new WeakSet<HTMLElement>();

  // querySelectorAll returns descendants in document order; dedupe by identity
  // so a <p> that happens to contain an <h3> (malformed HTML) doesn't produce
  // a synthetic feature from its own text once the <h3> inside it takes over.
  const blocks = sb.querySelectorAll('h3, p');
  for (const node of blocks) {
    if (node.tagName === 'H3') {
      seenFirstH3 = true;
      const heading = cleanText(node.text).toLowerCase();
      const key = SECTION_HEADINGS[heading];
      currentSectionKey = key ?? null;
      if (key) sections[key] = sections[key] ?? [];
      continue;
    }

    if (node.tagName !== 'P') continue;

    // Skip a <p> if we've already processed one of its ancestors (shouldn't
    // happen with valid HTML, but defensive against odd nesting).
    let ancestor: HTMLElement | null = node.parentNode as HTMLElement | null;
    let skip = false;
    while (ancestor) {
      if (seenPIds.has(ancestor)) { skip = true; break; }
      ancestor = ancestor.parentNode as HTMLElement | null;
    }
    if (skip) continue;
    seenPIds.add(node);

    const feature = parseFeatureParagraph(node);
    if (!feature) continue;

    if (!seenFirstH3) {
      traits.push(feature);
    } else if (currentSectionKey) {
      sections[currentSectionKey].push(feature);
    }
  }

  return { traits, sections };
}

/**
 * Turn a single `<p><strong><em>Name.</em></strong> description…</p>` into
 * a feature. Returns null if the paragraph doesn't look like a feature entry.
 */
function parseFeatureParagraph(p: HTMLElement): StatblockFeature | null {
  // Feature-name marker is a <strong> whose child text ends with a period (or colon).
  const firstStrong = p.querySelector('strong');
  if (!firstStrong) return null;

  const nameText = cleanText(firstStrong.text).replace(/[.:]\s*$/, '');
  if (!nameText) return null;

  // Description = paragraph text minus the leading strong-name, trimmed.
  const fullText = cleanText(p.text);
  // Strip the leading name + terminator.
  const trailing = fullText.replace(
    new RegExp('^' + escapeRegex(nameText) + '[.:]\\s*'),
    '',
  );

  return { name: nameText, description: trailing };
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === NodeType.ELEMENT_NODE;
}
