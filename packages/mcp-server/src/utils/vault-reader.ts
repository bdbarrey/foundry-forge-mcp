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
import { fileURLToPath } from 'url';

export type PortraitCanon = 'custom' | 'beneos' | 'needs-upgrade';

export interface VaultNpcLookup {
  /** Path the lookup matched against (for diagnostics). */
  filePath: string;
  /** portrait_canon frontmatter value, or null if absent. */
  portraitCanon: PortraitCanon | null;
}

// Resolution order for the NPC folder path (first hit wins). Env vars
// win over the config file so a machine that already has OBSIDIAN_VAULT_PATH
// set (e.g. the desktop WSL with ~/.hermes/.env) doesn't have to also
// keep cos-config.json in sync. The config file is the fallback for
// machines (e.g. the laptop) where env-side configuration is awkward.
//
//   1. COS_VAULT_NPC_PATH env var — explicit override, points at the
//      NPC folder directly.
//   2. OBSIDIAN_VAULT_PATH env var + standard layout under it
//      (`<vaultPath>/personal/D&D/Curse of Strahd/03 - Character/NPC`).
//   3. `cos-config.json` at the foundry-vtt-mcp repo root with
//      `{ "vaultPath": "..." }`. Per-machine; gitignored. Same standard
//      layout applies.
//
// All-null = no vault available; callers fall back to pre-existing
// behavior (silent no-op).
const STANDARD_NPC_SUBPATH = path.join(
  'personal', 'D&D', 'Curse of Strahd', '03 - Character', 'NPC',
);

let cachedConfigVaultPath: string | null | undefined = undefined;

function loadConfigVaultPath(): string | null {
  if (cachedConfigVaultPath !== undefined) return cachedConfigVaultPath;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/utils/vault-reader.js → up four to repo root.
    // src/utils/vault-reader.ts → up four to repo root (ts-node fallback).
    const candidates = [
      path.resolve(here, '..', '..', '..', '..', 'cos-config.json'),
      path.resolve(here, '..', '..', '..', 'cos-config.json'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        const vp = parsed?.vaultPath;
        if (typeof vp === 'string' && vp.trim()) {
          cachedConfigVaultPath = vp.trim();
          return cachedConfigVaultPath;
        }
      }
    }
  } catch {
    // Silent — cos-config.json is optional.
  }
  cachedConfigVaultPath = null;
  return null;
}

function resolveVaultNpcDir(): string | null {
  // 1. Explicit override.
  const explicit = process.env.COS_VAULT_NPC_PATH;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  // 2. OBSIDIAN_VAULT_PATH env var.
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (vault && vault.trim()) {
    return path.join(vault.trim(), STANDARD_NPC_SUBPATH);
  }
  // 3. cos-config.json at repo root (fallback for machines without env).
  const configVault = loadConfigVaultPath();
  if (configVault) {
    return path.join(configVault, STANDARD_NPC_SUBPATH);
  }
  return null;
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
  const diag = readPortraitCanonFromVaultDiag(npcName);
  return diag.result;
}

/**
 * Diagnostic-bearing variant — returns the same `result` as
 * `readPortraitCanonFromVault` PLUS a `diag` trace of which resolution
 * step succeeded, which paths were tried, and why each candidate failed.
 * Surfaced through audit-actor's snapshot so silent vault-reader misses
 * (Arc I AAR 2026-05-19 — cos-config.json shipped but auto-canon still
 * not firing) can be debugged from the tool response instead of needing
 * server-side log access.
 */
export interface VaultNpcLookupDiag {
  result: VaultNpcLookup | null;
  diag: {
    envCosVaultNpcPath: string | null;
    envObsidianVaultPath: string | null;
    configVaultPath: string | null;
    resolvedNpcDir: string | null;
    dirExists: boolean;
    candidatesTried: Array<{ filename: string; fullPath: string; existed: boolean; canon: string | null }>;
  };
}

export function readPortraitCanonFromVaultDiag(npcName: string): VaultNpcLookupDiag {
  const envExplicit = process.env.COS_VAULT_NPC_PATH ?? null;
  const envVault = process.env.OBSIDIAN_VAULT_PATH ?? null;
  const configVault = loadConfigVaultPath();
  const dir = resolveVaultNpcDir();
  const diag: VaultNpcLookupDiag['diag'] = {
    envCosVaultNpcPath: envExplicit && envExplicit.trim() ? envExplicit.trim() : null,
    envObsidianVaultPath: envVault && envVault.trim() ? envVault.trim() : null,
    configVaultPath: configVault,
    resolvedNpcDir: dir,
    dirExists: false,
    candidatesTried: [],
  };
  if (!dir) return { result: null, diag };
  try {
    diag.dirExists = fs.existsSync(dir);
  } catch {
    diag.dirExists = false;
  }
  if (!diag.dirExists) return { result: null, diag };
  for (const filename of candidateFilenames(npcName)) {
    const filePath = path.join(dir, filename);
    let existed = false;
    let canon: PortraitCanon | null = null;
    try {
      existed = fs.existsSync(filePath);
      if (existed) {
        const content = fs.readFileSync(filePath, { encoding: 'utf-8' });
        canon = parsePortraitCanon(content);
      }
    } catch {
      existed = false;
    }
    diag.candidatesTried.push({ filename, fullPath: filePath, existed, canon });
    if (existed) {
      return { result: { filePath, portraitCanon: canon }, diag };
    }
  }
  return { result: null, diag };
}
