// Phase 9: feat-icons.
//
// Reloaded-only traits + scratch-built actions previously landed with dnd5e's
// generic feature icon (the yellow star). This resolver picks a themed icon
// based on the feat's name and parsed combat data — and validates that the
// chosen URL actually serves a 200 before stamping it on an item.
//
// Architecture:
//   - Each NAME_ICON_CHAIN entry has 1+ candidate URLs, ordered preferred-first.
//   - resolveFeatIcon walks the chain, HEAD-probes each candidate (cached
//     per-session), and returns the first reachable URL. Falls through to
//     combat-shape heuristics (save/attack/damage system SVGs) if no name
//     candidate works, then to feature.svg as final fallback.
//   - System paths (`systems/...`) and svg paths (`icons/svg/...`) are trusted
//     without probing — they're served by Foundry's local asset server, not
//     by a public CDN, so HEAD requests from the backend can't reach them.
//   - Forge bazaar URLs (`https://assets.forge-vtt.com/bazaar/core/icons/...`)
//     ARE publicly accessible, so HEAD-probing works against them.
//
// The chain shape catches both my own mistakes (broken paths I added by hand)
// and future dnd5e/Forge reorganizations — when a path 404s the resolver
// silently rolls forward to the next candidate.

import type { ParsedAction } from '../parsers/action-description.js';

const FORGE_CORE = 'https://assets.forge-vtt.com/bazaar/core/icons';
const DND5E_ACTIVITY = 'systems/dnd5e/icons/svg/activity';
const FEATURE_FALLBACK = 'systems/dnd5e/icons/svg/items/feature.svg';

/**
 * Per-session cache of URL → 200/not-200. Keeps the cost of repeated
 * resolution at one HEAD request per unique URL across the backend's
 * lifetime. Cleared only when the backend restarts.
 */
const reachableCache = new Map<string, boolean>();

/**
 * Internal HEAD-probe with caching + 2s timeout. Returns true for 2xx,
 * false for non-success / network error / timeout. Caches per session.
 */
async function probeUrl(url: string): Promise<boolean> {
  const cached = reachableCache.get(url);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    const ok = res.ok;
    reachableCache.set(url, ok);
    return ok;
  } catch {
    reachableCache.set(url, false);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate an icon URL by probing whether it actually resolves.
 *
 * Three resolution modes:
 *   1. **Trusted local prefixes** (`systems/...`, `icons/svg/...`, `modules/...`)
 *      — served by Foundry's static asset server, can't HEAD from backend.
 *      Returns true without probing; we trust them as system-bundled.
 *   2. **Bare core icons** (`icons/...` other than `icons/svg/...`) — Foundry's
 *      core icon library, served by Forge worlds via the bazaar/core mirror.
 *      We probe by mapping to `${FORGE_CORE}/...` and HEAD-checking. This
 *      catches made-up filenames like `icons/weapons/crossbows/crossbow-heavy.webp`
 *      that don't exist in core (404) BUT also confirms real ones like
 *      `icons/weapons/swords/shortsword-guard-brass.webp` (200).
 *   3. **Absolute http(s) URLs** — probe directly. Catches Forge bazaar URLs,
 *      module-CDN URLs, etc.
 *
 * Empty string → false. Non-http non-icons scheme → false (can't probe).
 */
export async function validateIconUrl(url: string): Promise<boolean> {
  if (!url) return false;

  // Trusted local-asset prefixes — assume reachable, don't probe.
  if (url.startsWith('systems/')
   || url.startsWith('icons/svg/')
   || url.startsWith('modules/')) {
    return true;
  }

  // Bare core icons (icons/skills/..., icons/weapons/..., icons/creatures/...)
  // resolve through Forge bazaar mirror on Forge-hosted worlds. Probe via the
  // public bazaar URL — if the file exists there, the bare path will resolve
  // in Foundry; if it 404s on bazaar, it 404s in Foundry too.
  if (url.startsWith('icons/')) {
    return await probeUrl(`${FORGE_CORE}/${url.replace(/^icons\//, '')}`);
  }

  // Anything that isn't an http(s) URL we can't probe; treat as unreachable.
  if (!/^https?:\/\//.test(url)) return false;

  return await probeUrl(url);
}

/** Test-only helper: clear the reachability cache between tests. */
export function _clearIconReachabilityCache(): void {
  reachableCache.clear();
}

/**
 * Curated name → candidate-chain table. Keys are lowercase fragments matched
 * as substrings against the feat name. Values are ordered candidate URLs;
 * resolver picks the first that 200s.
 *
 * Order matters for keys: longer/more-specific keys must come before shorter
 * ones if both could match the same name (lookup walks in declaration order
 * and short-circuits on first hit).
 *
 * Most chains end with a verified-good icon as a safety net. The hand-curated
 * verified set comes from probing dnd5e 5.x compendium feats live or from
 * items observed in Ben's CoS world. If a top-pick path 404s the resolver
 * cascades to the verified fallback automatically.
 */
const NAME_ICON_CHAINS: ReadonlyArray<readonly [string, readonly string[]]> = [
  // Spellcasting
  ['innate spellcasting', [
    `${FORGE_CORE}/magic/fire/explosion-embers-orange.webp`, // verified
  ]],
  ['spellcasting', [
    `${FORGE_CORE}/magic/fire/explosion-embers-orange.webp`,
  ]],

  // Movement / escape
  ['misty escape', [
    `${FORGE_CORE}/magic/movement/door-frame-glow-blue.webp`,
    `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`,
  ]],
  ['misty step', [
    `${FORGE_CORE}/magic/movement/door-frame-glow-blue.webp`,
    `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`,
  ]],
  ['nimble escape', [
    `${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`, // verified (world Volenta)
  ]],
  ['vanish', [
    `${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`,
  ]],
  ['hide', [
    `${FORGE_CORE}/skills/social/intimidation-impressed-yellow.webp`,
    `${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`,
  ]],
  ['stealth', [
    `${FORGE_CORE}/skills/social/intimidation-impressed-yellow.webp`,
    `${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`,
  ]],
  ['leap', [
    `${FORGE_CORE}/skills/movement/figure-running-gray.webp`, // verified (Charge 24)
  ]],
  ['spider climb', [
    `${FORGE_CORE}/creatures/invertebrates/spider-pink-purple.webp`, // verified (world Volenta)
  ]],
  ['climb', [
    `${FORGE_CORE}/creatures/invertebrates/spider-pink-purple.webp`,
  ]],
  ['charge', [
    `${FORGE_CORE}/skills/movement/figure-running-gray.webp`, // verified (Charge 24)
  ]],

  // Defensive
  ['legendary resistance', [
    `${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`, // verified (Legendary Resistance 24)
  ]],
  ['parry', [
    `${FORGE_CORE}/skills/melee/swords-parry-block-blue.webp`, // verified (Parry 24)
  ]],
  ['shield', [
    `${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`,
  ]],
  ['evasion', [
    `${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`,
  ]],
  ['fey ancestry', [
    `${FORGE_CORE}/magic/control/fae-fairy-flower-green.webp`,
    `${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`,
  ]],
  ['indomitable', [
    `${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`,
  ]],
  ['mask of the wild', [
    `${FORGE_CORE}/skills/social/intimidation-impressed-yellow.webp`,
  ]],
  ['vampire weaknesses', [
    `${FORGE_CORE}/magic/time/day-night-sunset-sunrise.webp`, // verified (world Volenta)
  ]],
  ['magic resistance', [
    `${FORGE_CORE}/magic/defensive/shield-barrier-glowing-blue.webp`,
    `${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`,
  ]],
  ['resistance', [
    `${FORGE_CORE}/magic/defensive/shield-barrier-glowing-blue.webp`,
    `${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`,
  ]],

  // Offensive / multiattack family
  ['multiattack', [
    `${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`, // verified (Multiattack 24)
  ]],
  ['pack tactics', [
    `${FORGE_CORE}/creatures/abilities/wolf-heads-swirl-purple.webp`, // verified (Pack Tactics 24)
  ]],
  ['savage', [
    `${FORGE_CORE}/creatures/abilities/fangs-teeth-bite.webp`, // verified (Bite 24)
  ]],
  ['frenzy', [
    `${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`, // verified (world Volenta Bloodlust)
  ]],
  ['bloodlust', [
    `${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`,
  ]],
  ['blood frenzy', [
    `${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`,
  ]],
  ['reckless', [
    `${FORGE_CORE}/skills/melee/strike-axe-light-orange.webp`,
    `${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`,
  ]],

  // Natural attacks
  ['bite', [
    `${FORGE_CORE}/creatures/abilities/fangs-teeth-bite.webp`, // verified (Bite 24)
  ]],
  ['claws', [
    `${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`, // verified (Claws 24)
  ]],
  ['claw', [
    `${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`,
  ]],
  ['gore', [
    `${FORGE_CORE}/creatures/abilities/fangs-teeth-bite.webp`,
  ]],
  ['tail', [
    `${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`,
  ]],
  ['stinger', [
    `${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`,
  ]],
  ['constrict', [
    `${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`,
  ]],

  // Breath / area
  ['breath weapon', [
    `${FORGE_CORE}/magic/acid/projectile-stream-bubbles.webp`,
    `${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`,
  ]],
  ['acid breath', [
    `${FORGE_CORE}/magic/acid/projectile-stream-bubbles.webp`, // verified (Acid Breath 24)
  ]],
  ['fire breath', [
    `${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`, // verified (world Volenta Firebomb)
  ]],
  ['cold breath', [
    `${FORGE_CORE}/magic/water/wave-water-blue.webp`,
    `${FORGE_CORE}/magic/acid/projectile-stream-bubbles.webp`,
  ]],
  ['lightning breath', [
    `${FORGE_CORE}/magic/lightning/bolt-strike-blue.webp`,
    `${FORGE_CORE}/magic/acid/projectile-stream-bubbles.webp`,
  ]],
  ['poison breath', [
    `${FORGE_CORE}/magic/death/skull-poison-green.webp`,
    `${FORGE_CORE}/magic/acid/projectile-stream-bubbles.webp`,
  ]],

  // Charm / fear / mental
  ['charm', [
    `${FORGE_CORE}/magic/control/fae-fairy-flower-green.webp`,
    `${FORGE_CORE}/magic/unholy/silhouette-robe-evil-glow.webp`,
  ]],
  ['frightful presence', [
    `${FORGE_CORE}/magic/unholy/silhouette-robe-evil-glow.webp`, // verified (Frightful Presence 24)
  ]],
  ['psychic scream', [
    `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`,
    `${FORGE_CORE}/magic/unholy/silhouette-robe-evil-glow.webp`,
  ]],
  ['screams of the dead', [
    `${FORGE_CORE}/magic/unholy/silhouette-robe-evil-glow.webp`, // same as Frightful
  ]],

  // Status / control / restraints
  ['paralysis', [
    `${FORGE_CORE}/magic/control/voodoo-doll-pain-purple.webp`,
    `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`,
  ]],
  ['paralyzing', [
    `${FORGE_CORE}/magic/control/voodoo-doll-pain-purple.webp`,
    `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`,
  ]],
  ['petrify', [
    `${FORGE_CORE}/magic/earth/projectile-boulder-debris.webp`, // verified (world Volenta Thunderstone)
  ]],
  ['web', [
    `${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`, // verified (world Volenta TangleFoot)
  ]],
  ['tanglefoot', [
    `${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`,
  ]],
  ['grappler', [
    `${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`,
  ]],

  // Sunlight / light (verified: Sunlight Sensitivity 24 + world Volenta)
  ['sunlight hypersensitivity', [
    `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`, // verified
  ]],
  ['sunlight sensitivity', [
    `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`,
  ]],
  ['sunlight', [
    `${FORGE_CORE}/magic/light/explosion-star-glow-orange.webp`, // verified (world Volenta)
  ]],
  ['illumination', [
    `${FORGE_CORE}/magic/light/explosion-star-glow-orange.webp`,
  ]],

  // Alchemical thrown items
  ['firebomb', [
    `${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`, // verified
  ]],
  ['alchemist', [
    `${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`,
  ]],
  ['thunderstone', [
    `${FORGE_CORE}/magic/earth/projectile-boulder-debris.webp`, // verified (world Volenta)
  ]],
  ['smokestick', [
    `${FORGE_CORE}/magic/air/fog-gas-smoke-dense-brown.webp`, // verified (world Volenta)
  ]],

  // Heal / regen
  ['regeneration', [
    `${FORGE_CORE}/skills/wounds/injury-stitched-flesh-red.webp`, // verified (Regeneration 24)
  ]],
  ['second wind', [
    `${FORGE_CORE}/skills/wounds/injury-stitched-flesh-red.webp`,
  ]],

  // Ranged-themed traits — paths past the verified strike-weapons fallback
  // were unreachable in 5.x, so these now lead with the verified path.
  ['close quarters fighter', [
    `${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`, // verified
    `${DND5E_ACTIVITY}/attack.svg`,
  ]],
  ['hail of daggers', [
    `${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`,
    `${DND5E_ACTIVITY}/attack.svg`,
  ]],

  // Generic categories
  ['ritual', [
    `${FORGE_CORE}/magic/symbols/runes-carved-stone-grey.webp`,
    `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`,
  ]],
  ['shapechange', [
    `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`,
  ]],
  ['change shape', [
    `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`,
  ]],

  // Sense / detection
  ['blindsight', [
    `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`,
  ]],
  ['truesight', [
    `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`,
  ]],
  ['darkvision', [
    `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`,
  ]],
  ['keen senses', [
    `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`,
  ]],
];

/**
 * Async resolver. Picks the first reachable URL in the matching name chain;
 * falls through to combat-shape heuristics (system SVGs, always trusted),
 * then to the generic feature fallback.
 */
export async function resolveFeatIcon(
  name: string,
  parsed?: ParsedAction | null,
): Promise<string> {
  const lower = (name ?? '').toLowerCase();

  // 1. Name-based candidates.
  for (const [key, candidates] of NAME_ICON_CHAINS) {
    if (!lower.includes(key)) continue;
    for (const url of candidates) {
      if (await validateIconUrl(url)) return url;
    }
    // Matched the name but no candidate worked — fall through to shape.
    break;
  }

  // 2. Combat-shape heuristics. dnd5e activity SVGs are system-bundled and
  //    treated as always-reachable.
  if (parsed) {
    if (parsed.save) return `${DND5E_ACTIVITY}/save.svg`;
    if (parsed.attackBonus !== undefined || parsed.attackType) {
      return `${DND5E_ACTIVITY}/attack.svg`;
    }
    if (parsed.damage && parsed.damage.length > 0) {
      return `${DND5E_ACTIVITY}/damage.svg`;
    }
  }

  // 3. Final fallback.
  return FEATURE_FALLBACK;
}

/** Path returned when nothing in the lookup or heuristics matched. */
export const FEATURE_FALLBACK_PATH = FEATURE_FALLBACK;

/**
 * Default icons we treat as "needs replacement" when the retrofit pass walks
 * an actor. Includes:
 *  - dnd5e's bundled feature icon (the yellow star)
 *  - Foundry core item-bag / mystery-man (generic stand-ins)
 *  - All known stale Phase 9 paths from the dnd5e 4.x abilities folder so an
 *    actor built before the path-fix can still be repaired by retrofit.
 *
 * Items with a current img NOT in this set AND that fail HEAD validation are
 * also eligible for replacement — that path catches future-broken URLs we
 * haven't enumerated yet.
 */
export const DND5E_DEFAULT_FEAT_ICONS: ReadonlySet<string> = new Set([
  'systems/dnd5e/icons/svg/items/feature.svg',
  'icons/svg/item-bag.svg',
  'icons/svg/mystery-man.svg',
  'icons/svg/clockwork.svg',
  // Stale Phase 9 paths (dnd5e 4.x abilities folder; doesn't render in 5.x).
  'systems/dnd5e/icons/svg/abilities/multiattack.svg',
  'systems/dnd5e/icons/svg/abilities/regenerate.svg',
  'systems/dnd5e/icons/svg/abilities/sunlight.svg',
  'systems/dnd5e/icons/svg/abilities/web.svg',
  'systems/dnd5e/icons/svg/abilities/agility.svg',
  'systems/dnd5e/icons/svg/abilities/stealthy.svg',
  'systems/dnd5e/icons/svg/abilities/vanish.svg',
  'systems/dnd5e/icons/svg/abilities/hover.svg',
  'systems/dnd5e/icons/svg/abilities/swim.svg',
  'systems/dnd5e/icons/svg/abilities/special.svg',
  'systems/dnd5e/icons/svg/abilities/parry.svg',
  'systems/dnd5e/icons/svg/abilities/shield.svg',
  'systems/dnd5e/icons/svg/abilities/charm.svg',
  'systems/dnd5e/icons/svg/abilities/cleave.svg',
  'systems/dnd5e/icons/svg/abilities/charge.svg',
  'systems/dnd5e/icons/svg/abilities/savage.svg',
  'systems/dnd5e/icons/svg/abilities/frenzy.svg',
  'systems/dnd5e/icons/svg/abilities/claw.svg',
  'systems/dnd5e/icons/svg/abilities/gore.svg',
  'systems/dnd5e/icons/svg/abilities/breath-weapon.svg',
  'systems/dnd5e/icons/svg/abilities/paralysis.svg',
  'systems/dnd5e/icons/svg/abilities/illumination.svg',
  'systems/dnd5e/icons/svg/abilities/sense.svg',
  'systems/dnd5e/icons/svg/abilities/resistance.svg',
  'systems/dnd5e/icons/svg/abilities/ritual.svg',
  'systems/dnd5e/icons/svg/abilities/change-shape.svg',
  'systems/dnd5e/icons/svg/abilities/second-wind.svg',
  'systems/dnd5e/icons/svg/abilities/pact-magic.svg',
  'systems/dnd5e/icons/svg/abilities/melee-attack.svg',
  'systems/dnd5e/icons/svg/abilities/ranged-attack.svg',
  // Stale Phase 9 ranged path (skills/ranged/arrow-flying-shaft-orange.webp
  // doesn't exist on Forge bazaar).
  'https://assets.forge-vtt.com/bazaar/core/icons/skills/ranged/arrow-flying-shaft-orange.webp',
]);
