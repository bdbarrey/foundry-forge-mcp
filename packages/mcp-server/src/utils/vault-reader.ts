/**
 * Vault frontmatter reader — reads NPC portrait_canon from the Obsidian
 * vault so server-side tools can auto-apply the right portrait without the
 * caller having to pass `portrait_canon` explicitly.
 *
 * Origin: Arc I AAR 2026-05-19 — user surfaced that `apply-actor-portrait`
 * was getting skipped entirely for several actors after `create-actor`,
 * and that `audit-actor`'s portrait-canon check only fired when the
 * caller remembered to pass `expected_portrait_canon`. Both failure modes
 * were silent in the pre-existing flow. This module lets the tools
 * self-resolve canon from the vault file at the right times, eliminating
 * the agent-discipline failure mode.
 *
 * Vault location:
 *   - Reads from env var COS_VAULT_NPC_PATH (explicit override) OR
 *     ${OBSIDIAN_VAULT_PATH}/personal/D&D/Curse of Strahd/03 - Character/NPC
 *   - Returns null on any error (missing env, missing file, malformed
 *     frontmatter). Errors are NEVER fatal — the calling tool falls back
 *     to its pre-existing behavior so this stays backwards-compatible.
 *
 * Matching:
 *   - Exact filename match: `<NPC display name>.md`. Case-sensitive
 *     because Obsidian wiki-link resolution is case-sensitive.
 *   - For multi-form actors ("Baba Lysaga, Witch Mother"), falls back to
 *     pre-comma form ("Baba Lysaga.md") — matches the canonical vault file.
 */

import * as fs from 'fs';
import * as path from 'path';

export type PortraitCanon = 'custom' | 'beneos' | 'needs-upgrade';

export interface VaultNpcLookup {
  /** Path the lookup matched against (for diagnostics). */
  filePath: string;
  /** portrait_canon frontmatter value, or null if absent. */
  portraitCanon: PortraitCanon | null;
}

function resolveVaultNpcDir(): string | null {
  // Explicit override wins.
  const explicit = process.env.COS_VAULT_NPC_PATH;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  // Fall back to standard layout under OBSIDIAN_VAULT_PATH.
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (!vault || !vault.trim()) {
    return null;
  }
  return path.join(
    vault.trim(),
    'personal',
    'D&D',
    'Curse of Strahd',
    '03 - Character',
    'NPC',
  );
}

function candidateFilenames(npcName: string): string[] {
  const base = npcName.trim();
  if (!base) return [];
  const out: string[] = [`${base}.md`];
  // Pre-comma form: "Baba Lysaga, Witch Mother" → "Baba Lysaga.md".
  // Matches the canonical vault file for multi-form actors per the
  // First Form naming convention (feedback_first_form_naming.md).
  if (base.includes(',')) {
    const stem = base.split(',')[0].trim();
    if (stem && stem !== base) out.push(`${stem}.md`);
  }
  return out;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const PORTRAIT_CANON_RE = /^\s*portrait_canon\s*:\s*([A-Za-z_-]+)\s*$/m;

function parsePortraitCanon(content: string): PortraitCanon | null {
  const fm = content.match(FRONTMATTER_RE);
  if (!fm) return null;
  const m = fm[1].match(PORTRAIT_CANON_RE);
  if (!m) return null;
  const value = m[1].trim();
  if (value === 'custom' || value === 'beneos' || value === 'needs-upgrade') {
    return value;
  }
  return null;
}

/**
 * Look up an NPC's portrait_canon from the vault.
 *
 * Returns null if:
 *  - vault path env var isn't set
 *  - no matching `.md` file exists for the NPC
 *  - the file has no `portrait_canon` frontmatter
 *  - any filesystem error reading the file
 *
 * Errors are silent. The intent is to AUGMENT tool behavior when the vault
 * is reachable, not to introduce a new failure mode when it isn't.
 */
export function readPortraitCanonFromVault(npcName: string): VaultNpcLookup | null {
  const dir = resolveVaultNpcDir();
  if (!dir) return null;
  try {
    if (!fs.existsSync(dir)) return null;
  } catch {
    return null;
  }
  for (const filename of candidateFilenames(npcName)) {
    const filePath = path.join(dir, filename);
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, { encoding: 'utf-8' });
      const canon = parsePortraitCanon(content);
      return { filePath, portraitCanon: canon };
    } catch {
      // Continue trying remaining candidates rather than fail loudly.
      continue;
    }
  }
  return null;
}
