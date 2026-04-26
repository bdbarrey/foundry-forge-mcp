// Reloaded prose-spec parser.
//
// Handles Reloaded sections that DON'T provide a `<div class="statblock">`
// block. These are creatures whose Reloaded entry is prose-only:
//
//   "Father Lucian retains the statistics of a **priest**. However, his
//    ***divine eminence*** feature now reads as follows:
//      * ***Divine Eminence.*** As a reaction when he sees..."
//
//   "Wensencia's steed has the statistics of a **dire wolf**, but has a
//    **zombie**'s ***undead fortitude*** feature instead of a dire wolf's
//    ***pack tactics*** feature."
//
//   "Treat the crawling zombie as a **zombie** with the following modifications:"
//
// Output is a unified ReloadedProseSpec that the create-actor pipeline
// converts into compendium-spawn + feature-overrides + portrait — exact
// same downstream pipeline as the statblock case, just a different source
// of modifications.
//
// Pure functions; no Foundry / network access.

export interface FeatureOverride {
  name: string;
  description: string;
}

export interface ReloadedProseSpec {
  /** Display name of the creature, if recoverable from a [[link|Display]]. */
  name?: string;
  /** Bolded creature name to search the compendium for (e.g. "priest", "dire wolf"). */
  baseHint?: string;
  /** Feature-description rewrites pulled from "now reads as follows" blocks. */
  featureOverrides: FeatureOverride[];
}

/**
 * Parse a markdown section that lacks a statblock div. Returns null only
 * when no recognizable patterns are found at all (caller can decide what to
 * do — usually treat as "compendium reference" requiring an explicit
 * compendium_base).
 */
export function parseReloadedProseSpec(markdown: string): ReloadedProseSpec | null {
  if (!markdown || !markdown.trim()) return null;

  // Strip the heading line if present (`### N. Name` or `### Name`); we
  // operate on the body. Leave the line so name extraction can use it as a
  // fallback when no [[link]] is present.
  const lines = markdown.split(/\r?\n/);
  const body = lines.join('\n');

  const name = extractDisplayName(lines);
  const baseHint = extractBaseHint(body);
  const featureOverrides = extractFeatureOverrides(body);

  if (!baseHint && featureOverrides.length === 0) {
    // No prose-spec signals at all. Caller can decide whether to error or
    // fall through to a compendium-only spawn.
    return null;
  }

  return {
    ...(name ? { name } : {}),
    ...(baseHint ? { baseHint } : {}),
    featureOverrides,
  };
}

/**
 * Pull the display name off the section's heading or first [[link|Display]].
 * Reloaded headings vary: `### Father Lucian`, `### 2. Father Lucian`,
 * `### D4c. Volenta's Trap`. We strip the leading number/section prefix.
 */
function extractDisplayName(lines: string[]): string | undefined {
  // Try heading first.
  for (const line of lines.slice(0, 3)) {
    const m = line.match(/^#{1,4}\s+(?:[\dA-Za-z]+\.\s+)?(.+?)\s*$/);
    if (m) {
      const cleaned = m[1].trim();
      if (cleaned) return cleaned;
    }
  }

  // Fallback: first [[link|Display]] in body.
  for (const line of lines) {
    const link = line.match(/\[\[[^\]|]+\|([^\]]+)\]\]/);
    if (link) return link[1].trim();
    const bareLink = line.match(/\[\[([^\]|]+)\]\]/);
    if (bareLink) {
      const text = bareLink[1].trim();
      // Strip "Page#Anchor" → "Anchor"
      const anchor = text.split('#').pop();
      if (anchor) return anchor.trim();
    }
  }

  return undefined;
}

const BASE_HINT_VERBS = [
  // "retains the statistics of a/an", "has the statistics of"
  /\bretains the statistics of\s+(?:a |an |the )?\*\*([^*]+)\*\*/i,
  /\bhas the statistics of\s+(?:a |an |the )?\*\*([^*]+)\*\*/i,
  // "Treat (the <thing>) as a/an <creature>"
  /\bTreat\b[^.]*?\bas\s+(?:a |an |the )?\*\*([^*]+)\*\*/i,
  // "uses the X statblock", "uses the **X** statblock"
  /\buses\s+(?:a |an |the )?\*\*([^*]+)\*\*\s+statblock/i,
  // "is built on a **X**", "spawned as a **X**"
  /\b(?:is built on|spawned as|appears as|rises as)\s+(?:a |an |the )?\*\*([^*]+)\*\*/i,
];

function extractBaseHint(body: string): string | undefined {
  for (const re of BASE_HINT_VERBS) {
    const m = body.match(re);
    if (m && m[1]) {
      // Normalize: strip trailing punctuation, collapse whitespace.
      return m[1].replace(/[.,;:]+$/, '').replace(/\s+/g, ' ').trim();
    }
  }
  return undefined;
}

/**
 * Find feature-description rewrites. Pattern variations Reloaded uses:
 *
 *   "...her ***<feature>*** feature now reads as follows:
 *    * ***<Feature Name>.*** <new description>"
 *
 *   "...with the following modifications:
 *    * ***<Feature Name>.*** <new description>
 *    * ***<Other>.*** <other description>"
 *
 * Each bullet defines one override. The bullet description ends at the
 * next bullet, blank line, or heading. We keep the description as-is
 * (preserving inner markdown like *italics* and ***bold-italic***) since
 * downstream `create-actor` HTML-escapes when applying.
 */
function extractFeatureOverrides(body: string): FeatureOverride[] {
  const out: FeatureOverride[] = [];

  // Split body into bullet blocks. A bullet starts with `*` or `-` at line
  // start (with optional leading spaces) and runs until the next bullet,
  // blank line, or heading.
  const bulletRe = /^[ \t]*[*-][ \t]+(\*{2,3}[^*]+\*{2,3}[^]+?)(?=\n[ \t]*[*-][ \t]+\*{2,3}|\n\s*\n|\n#|$)/gm;

  let m: RegExpExecArray | null;
  while ((m = bulletRe.exec(body)) !== null) {
    const block = m[1];
    // First *** or ** group is the feature name; everything after the
    // closing markers + an optional period is the description.
    const head = block.match(/^\*{2,3}([^*]+?)\*{2,3}\.?\s*(.*)$/s);
    if (!head) continue;
    const name = head[1].trim().replace(/\.$/, '');
    const description = head[2].trim();
    if (!name || !description) continue;
    out.push({ name, description });
  }

  return out;
}
