import { describe, it, expect } from 'vitest';
import { portraitNameScore, rankPortraitCandidates, resolveBeneosPair } from './create-actor.js';
import type { ForgeAssetEntry } from '../forge-assets-client.js';

describe('portraitNameScore', () => {
  it('returns 1.0 for normalized exact match', () => {
    expect(portraitNameScore('Volenta', 'Volenta')).toBe(1.0);
    expect(portraitNameScore('Volenta_First_Form', 'volenta first form')).toBe(1.0);
  });

  it('returns 0.85 for compact substring match (creature name shorter than file stem)', () => {
    // "Volenta" (pre-comma stem) vs "Volenta_First_Form" — substring branch.
    expect(portraitNameScore('Volenta', 'Volenta_First_Form')).toBe(0.85);
  });

  it('returns 1.0 when underscores/punctuation make names normalize-equal', () => {
    // "Volenta, First Form" → "volenta first form"
    // "Volenta_First_Form" → "volenta first form"
    // Both normalize to identical strings — that's an exact match by intent.
    expect(portraitNameScore('Volenta, First Form', 'Volenta_First_Form')).toBe(1.0);
  });

  it('returns Jaccard overlap when neither equal nor substring', () => {
    // "Wight Commander" tokens {wight, commander} vs "Wight Officer" tokens {wight, officer}
    // Jaccard = 1 / max(2,2) = 0.5
    expect(portraitNameScore('Wight Commander', 'Wight Officer')).toBe(0.5);
  });

  it('returns 0 for completely unrelated names', () => {
    expect(portraitNameScore('Volenta', 'Bandit')).toBe(0);
  });

  it('handles names with non-alphanumerics (apostrophes, parens)', () => {
    expect(portraitNameScore("Alchemist's Firebomb (1/Day)", 'alchemists_firebomb'))
      .toBe(0.85);
  });

  it('returns 0 for empty inputs', () => {
    expect(portraitNameScore('', 'anything')).toBe(0);
    expect(portraitNameScore('Volenta', '')).toBe(0);
  });
});

describe('rankPortraitCandidates', () => {
  const entries: ForgeAssetEntry[] = [
    { path: 'cos_tokens/Volenta_First_Form.webp', name: 'Volenta_First_Form.webp' },
    { path: 'cos_tokens/Volenta_Second_Form.webp', name: 'Volenta_Second_Form.webp' },
    { path: 'cos_tokens/Wight_Commander.webp', name: 'Wight_Commander.webp' },
    { path: 'cos_tokens/Bandit.webp', name: 'Bandit.webp' },
    { path: 'cos_tokens/Vampire_Spawn.webp', name: 'Vampire_Spawn.webp' },
  ];

  it('picks the exact-form match over the bare-name match when both exist', () => {
    // Candidate variants for "Volenta, First Form": full + pre-comma stem
    const ranked = rankPortraitCandidates(entries, ['Volenta, First Form', 'Volenta'], 5);
    expect(ranked[0].entry.name).toBe('Volenta_First_Form.webp');
    // Both Volenta files match — first form should outrank second on full-name substring score.
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it('returns empty when nothing matches', () => {
    const ranked = rankPortraitCandidates(entries, ['Mind Flayer'], 5);
    expect(ranked).toEqual([]);
  });

  it('respects the limit parameter', () => {
    const ranked = rankPortraitCandidates(entries, ['Volenta'], 1);
    expect(ranked).toHaveLength(1);
  });

  it('attaches matchedAgainst (which variant won) so callers can show provenance', () => {
    const ranked = rankPortraitCandidates(entries, ['Volenta, First Form', 'Volenta'], 5);
    expect(ranked[0].matchedAgainst).toBeDefined();
    expect(typeof ranked[0].matchedAgainst).toBe('string');
  });

  it('prefers entries with full URL when path/url both exist (no special handling — both reach caller)', () => {
    const withUrl: ForgeAssetEntry[] = [
      { path: 'cos_tokens/Volenta.webp', name: 'Volenta.webp', url: 'https://assets.forge-vtt.com/abc/Volenta.webp' },
    ];
    const ranked = rankPortraitCandidates(withUrl, ['Volenta'], 1);
    expect(ranked[0].entry.url).toBe('https://assets.forge-vtt.com/abc/Volenta.webp');
  });

  it('strips one extension only — "Volenta.token.webp" stem becomes "Volenta.token"', () => {
    const odd: ForgeAssetEntry[] = [
      { path: 'cos_tokens/Volenta.token.webp', name: 'Volenta.token.webp' },
    ];
    const ranked = rankPortraitCandidates(odd, ['Volenta'], 1);
    // "Volenta" is a substring of "volenta token" → 0.85
    expect(ranked[0].score).toBe(0.85);
  });
});

describe('resolveBeneosPair', () => {
  // Mirror the cos_tokens convention discovered live: each NPC = portrait + token pair.
  const cosTokens: ForgeAssetEntry[] = [
    { path: 'cos_tokens/valenta_popofsky.webp', name: 'valenta_popofsky.webp',
      url: 'https://assets.forge-vtt.com/abc/valenta_popofsky.webp' },
    { path: 'cos_tokens/valenta_popofsky_token.webp', name: 'valenta_popofsky_token.webp',
      url: 'https://assets.forge-vtt.com/abc/valenta_popofsky_token.webp' },
    { path: 'cos_tokens/rahadin.webp', name: 'rahadin.webp' },
    { path: 'cos_tokens/rahadin_token.webp', name: 'rahadin_token.webp' },
  ];

  it('finds token sibling when matched on portrait variant', () => {
    const matched = cosTokens[0]; // valenta_popofsky.webp
    const pair = resolveBeneosPair(matched, cosTokens);
    expect(pair.portrait.name).toBe('valenta_popofsky.webp');
    expect(pair.token.name).toBe('valenta_popofsky_token.webp');
    expect(pair.tokenSiblingFound).toBe(true);
  });

  it('finds portrait sibling when matched on token variant', () => {
    const matched = cosTokens[1]; // valenta_popofsky_token.webp
    const pair = resolveBeneosPair(matched, cosTokens);
    expect(pair.portrait.name).toBe('valenta_popofsky.webp');
    expect(pair.token.name).toBe('valenta_popofsky_token.webp');
    expect(pair.tokenSiblingFound).toBe(true);
  });

  it('falls back to using matched URL for both slots when no sibling exists', () => {
    const lone: ForgeAssetEntry[] = [
      { path: 'tokens/Lonely.webp', name: 'Lonely.webp' },
    ];
    const pair = resolveBeneosPair(lone[0], lone);
    expect(pair.portrait.name).toBe('Lonely.webp');
    expect(pair.token.name).toBe('Lonely.webp');
    expect(pair.tokenSiblingFound).toBe(false);
  });

  it('preserves URL on both portrait and token entries', () => {
    const matched = cosTokens[0];
    const pair = resolveBeneosPair(matched, cosTokens);
    expect(pair.portrait.url).toContain('valenta_popofsky.webp');
    expect(pair.token.url).toContain('valenta_popofsky_token.webp');
  });

  it('case-insensitive sibling match (portrait Webp + token WEBP)', () => {
    const mixed: ForgeAssetEntry[] = [
      { path: 'p/Foo.webp', name: 'Foo.webp' },
      { path: 'p/Foo_token.WEBP', name: 'Foo_token.WEBP' },
    ];
    const pair = resolveBeneosPair(mixed[0], mixed);
    expect(pair.tokenSiblingFound).toBe(true);
    expect(pair.token.name).toBe('Foo_token.WEBP');
  });
});
