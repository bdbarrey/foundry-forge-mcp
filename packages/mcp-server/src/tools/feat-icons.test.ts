import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveFeatIcon,
  validateIconUrl,
  FEATURE_FALLBACK_PATH,
  DND5E_DEFAULT_FEAT_ICONS,
  _clearIconReachabilityCache,
} from './feat-icons.js';

const FORGE_CORE = 'https://assets.forge-vtt.com/bazaar/core/icons';
const DND5E_ACTIVITY = 'systems/dnd5e/icons/svg/activity';

/**
 * Mock fetch so the resolver's HEAD probes are deterministic without network.
 * Each test sets up which URLs should "exist" (200) vs 404.
 */
function setupFetch(reachable: Set<string>) {
  const fetchMock = vi.fn(async (url?: any, _init?: any) => {
    // Defensive: vi.fn types say url is string|URL but at runtime can receive
    // anything. Stringify safely; treat falsy as a 404.
    if (url === undefined || url === null) return { ok: false, status: 404 } as Response;
    const urlStr = typeof url === 'string' ? url : String(url);
    if (reachable.has(urlStr)) {
      return { ok: true, status: 200 } as Response;
    }
    return { ok: false, status: 404 } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  _clearIconReachabilityCache();
  vi.unstubAllGlobals();
});

describe('validateIconUrl', () => {
  it('trusts system/* paths without probing', async () => {
    const fetchMock = setupFetch(new Set());
    expect(await validateIconUrl('systems/dnd5e/icons/svg/items/feature.svg')).toBe(true);
    expect(await validateIconUrl('systems/dnd5e/icons/svg/activity/save.svg')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trusts icons/svg/* paths (Foundry core SVGs) without probing', async () => {
    const fetchMock = setupFetch(new Set());
    expect(await validateIconUrl('icons/svg/item-bag.svg')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns true for reachable http URLs and false for 404', async () => {
    setupFetch(new Set([`${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`]));
    expect(await validateIconUrl(`${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`)).toBe(true);
    expect(await validateIconUrl(`${FORGE_CORE}/does-not-exist.webp`)).toBe(false);
  });

  it('caches results — second call to the same URL does not re-probe', async () => {
    const fetchMock = setupFetch(new Set([`${FORGE_CORE}/foo.webp`]));
    await validateIconUrl(`${FORGE_CORE}/foo.webp`);
    await validateIconUrl(`${FORGE_CORE}/foo.webp`);
    await validateIconUrl(`${FORGE_CORE}/foo.webp`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns false for empty / non-http URLs without probing', async () => {
    const fetchMock = setupFetch(new Set());
    expect(await validateIconUrl('')).toBe(false);
    expect(await validateIconUrl('not-a-url')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false on network error / thrown fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await validateIconUrl(`${FORGE_CORE}/foo.webp`)).toBe(false);
  });
});

describe('resolveFeatIcon — name-table hits with all candidates reachable', () => {
  beforeEach(() => {
    // Default: every Forge URL is reachable.
    setupFetch(new Set([
      `${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`,
      `${FORGE_CORE}/creatures/abilities/wolf-heads-swirl-purple.webp`,
      `${FORGE_CORE}/skills/wounds/injury-stitched-flesh-red.webp`,
      `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`,
      `${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`,
      `${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`,
      `${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`,
      `${FORGE_CORE}/creatures/abilities/fangs-teeth-bite.webp`,
      `${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`,
      `${FORGE_CORE}/creatures/invertebrates/spider-pink-purple.webp`,
      `${FORGE_CORE}/skills/movement/figure-running-gray.webp`,
      `${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`,
      `${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`,
      `${FORGE_CORE}/skills/melee/swords-parry-block-blue.webp`,
      `${FORGE_CORE}/magic/unholy/silhouette-robe-evil-glow.webp`,
      `${FORGE_CORE}/magic/acid/projectile-stream-bubbles.webp`,
      `${FORGE_CORE}/magic/fire/explosion-embers-orange.webp`,
      `${FORGE_CORE}/magic/light/explosion-star-glow-orange.webp`,
      `${FORGE_CORE}/magic/earth/projectile-boulder-debris.webp`,
      `${FORGE_CORE}/magic/air/fog-gas-smoke-dense-brown.webp`,
      `${FORGE_CORE}/magic/movement/door-frame-glow-blue.webp`,
      `${FORGE_CORE}/magic/time/day-night-sunset-sunrise.webp`,
    ]));
  });

  it('multiattack → strike-weapons (verified)', async () => {
    expect(await resolveFeatIcon('Multiattack')).toBe(`${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`);
  });

  it('volenta-specific items map to themed icons', async () => {
    expect(await resolveFeatIcon('Tanglefoot')).toBe(`${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`);
    expect(await resolveFeatIcon("Alchemist's Firebomb")).toBe(`${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`);
    expect(await resolveFeatIcon('Awakened Bloodlust')).toBe(`${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`);
  });

  it('case-insensitive substring match', async () => {
    expect(await resolveFeatIcon('SUNLIGHT HYPERSENSITIVITY'))
      .toBe(`${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`);
    expect(await resolveFeatIcon('Greater Pack Tactics'))
      .toBe(`${FORGE_CORE}/creatures/abilities/wolf-heads-swirl-purple.webp`);
  });

  it('close quarters fighter falls to verified strike-weapons (formerly broken arrow path)', async () => {
    expect(await resolveFeatIcon('Close Quarters Fighter'))
      .toBe(`${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`);
  });
});

describe('resolveFeatIcon — chain fallback when primary 404s', () => {
  it('rolls forward to the second candidate when the first is unreachable', async () => {
    // Misty Step has [door-frame-glow, silhouette-aura]. Only the second works.
    setupFetch(new Set([`${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`]));
    expect(await resolveFeatIcon('Misty Step'))
      .toBe(`${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`);
  });

  it('falls through to combat-shape heuristic when ALL name candidates 404', async () => {
    // Make all name-chain candidates unreachable. Sunlight Sensitivity has a
    // single candidate (humanoid-single-blind) — when that 404s, no shape
    // info, so falls to feature.svg.
    setupFetch(new Set());
    const parsed = { damage: [], save: { dc: 14, ability: 'str' as const } };
    expect(await resolveFeatIcon('Sunlight Sensitivity', parsed)).toBe(`${DND5E_ACTIVITY}/save.svg`);
  });

  it('falls through to feature.svg when name fails AND no parsed shape', async () => {
    setupFetch(new Set());
    expect(await resolveFeatIcon('Sunlight Sensitivity')).toBe(FEATURE_FALLBACK_PATH);
  });
});

describe('resolveFeatIcon — combat-shape heuristics (no name match)', () => {
  beforeEach(() => setupFetch(new Set()));

  it('save-having item gets dnd5e save activity icon (system path, trusted)', async () => {
    const parsed = { damage: [], save: { dc: 14, ability: 'str' as const } };
    expect(await resolveFeatIcon('Made-Up Trap', parsed)).toBe(`${DND5E_ACTIVITY}/save.svg`);
  });

  it('attack-having item gets dnd5e attack activity icon', async () => {
    const parsed = { damage: [], attackBonus: 7, attackType: 'melee' as const };
    expect(await resolveFeatIcon('Made-Up Strike', parsed)).toBe(`${DND5E_ACTIVITY}/attack.svg`);
  });

  it('damage-only gets dnd5e damage activity icon', async () => {
    const parsed = { damage: [{ formula: '2d6', type: 'fire' }] };
    expect(await resolveFeatIcon('Made-Up Aura', parsed)).toBe(`${DND5E_ACTIVITY}/damage.svg`);
  });
});

describe('resolveFeatIcon — final fallback', () => {
  beforeEach(() => setupFetch(new Set()));

  it('returns feature.svg for unknown name + no parsed', async () => {
    expect(await resolveFeatIcon('Some Made-Up Trait')).toBe(FEATURE_FALLBACK_PATH);
  });

  it('returns feature.svg for empty name', async () => {
    expect(await resolveFeatIcon('')).toBe(FEATURE_FALLBACK_PATH);
  });
});

describe('DND5E_DEFAULT_FEAT_ICONS', () => {
  it('includes the dnd5e generic feature icon', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/items/feature.svg')).toBe(true);
  });

  it('includes Foundry core item-bag and mystery-man', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has('icons/svg/item-bag.svg')).toBe(true);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('icons/svg/mystery-man.svg')).toBe(true);
  });

  it('includes stale dnd5e 4.x abilities paths so retrofit can recover broken-icon items', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/web.svg')).toBe(true);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/multiattack.svg')).toBe(true);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/frenzy.svg')).toBe(true);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/ranged-attack.svg')).toBe(true);
  });

  it('includes the broken Phase 9 ranged URL so retrofit replaces it', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has(
      'https://assets.forge-vtt.com/bazaar/core/icons/skills/ranged/arrow-flying-shaft-orange.webp',
    )).toBe(true);
  });

  it('does NOT include verified themed bazaar URLs (those are replacements, not defaults)', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has(`${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`)).toBe(false);
    expect(DND5E_DEFAULT_FEAT_ICONS.has(`${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`)).toBe(false);
  });
});
