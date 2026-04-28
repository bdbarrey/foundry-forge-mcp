// Phase 9: feat-icons.
//
// Reloaded-only traits + scratch-built actions land with dnd5e's generic
// feature icon (the yellow star) because we don't set `img` when adding
// items via addActorItems. This resolver picks a themed icon based on the
// feat's name and parsed combat data.
//
// Icon sources:
//   1. Foundry core icons (`icons/...`) — the same library dnd5e 5.x's
//      compendium feats use. We store them as full Forge bazaar URLs
//      (`https://assets.forge-vtt.com/bazaar/core/icons/...`) so they render
//      reliably on Forge-hosted worlds. Self-hosted Foundry installs also
//      load these URLs since the CDN is public.
//   2. dnd5e system-bundled SVGs (`systems/dnd5e/icons/svg/activity/...`)
//      for the combat-shape heuristic fallbacks (save/attack/damage). These
//      paths are guaranteed by the dnd5e system install.
//
// IMPORTANT: an earlier draft of this file used `systems/dnd5e/icons/svg/
// abilities/<name>.svg` paths (carried over from dnd5e 4.x). That folder
// was reorganized in dnd5e 5.x and those paths render as broken images on
// the sheet. Every entry below has been verified against an existing
// dnd5e 5.x compendium feat or against an item already living in Ben's
// CoS world.
//
// Resolution order:
//   1. Curated NAME table (case-insensitive substring match) — covers
//      common monster traits.
//   2. Combat-shape heuristics off ParsedAction — has save → save activity
//      icon; has attack → attack activity icon; has damage → damage
//      activity icon. Uses dnd5e's bundled SVGs.
//   3. Generic feature fallback — better than the star, signals "no themed
//      match" so a future Forge-curated library could chain in.

import type { ParsedAction } from '../parsers/action-description.js';

const FORGE_CORE = 'https://assets.forge-vtt.com/bazaar/core/icons';
const DND5E_ACTIVITY = 'systems/dnd5e/icons/svg/activity';
const FEATURE_FALLBACK = 'systems/dnd5e/icons/svg/items/feature.svg';

/**
 * Curated name → icon table. Keys are lowercase fragments matched as
 * substrings against the feat name (so "Sunlight Hypersensitivity" hits
 * the "sunlight" entry; "Greater Pack Tactics" hits "pack tactics").
 *
 * Order matters: longer keys must be listed before shorter ones if both
 * could match the same feat name. The lookup walks entries in declaration
 * order and returns the first hit.
 *
 * Every URL below has been verified against either a dnd5e 5.x compendium
 * feat (probed live via `get-compendium-item`) or an item already in Ben's
 * CoS world. Comments tag the source so future maintainers know where to
 * look when adding entries.
 */
const NAME_ICON_MAP: ReadonlyArray<readonly [string, string]> = [
  // Spellcasting (verified: dnd5e.classfeatures Spellcasting)
  ['innate spellcasting', `${FORGE_CORE}/magic/fire/explosion-embers-orange.webp`],
  ['spellcasting', `${FORGE_CORE}/magic/fire/explosion-embers-orange.webp`],

  // Movement / escape (verified: world Volenta items + Charge feat)
  ['misty escape', `${FORGE_CORE}/magic/movement/door-frame-glow-blue.webp`],
  ['misty step', `${FORGE_CORE}/magic/movement/door-frame-glow-blue.webp`],
  ['nimble escape', `${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`],
  ['vanish', `${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`],
  ['hide', `${FORGE_CORE}/skills/social/intimidation-impressed-yellow.webp`],
  ['stealth', `${FORGE_CORE}/skills/social/intimidation-impressed-yellow.webp`],
  ['leap', `${FORGE_CORE}/skills/movement/figure-running-gray.webp`],
  ['spider climb', `${FORGE_CORE}/creatures/invertebrates/spider-pink-purple.webp`],
  ['climb', `${FORGE_CORE}/creatures/invertebrates/spider-pink-purple.webp`],
  ['charge', `${FORGE_CORE}/skills/movement/figure-running-gray.webp`],

  // Defensive (verified: Legendary Resistance, Parry from monsterfeatures24)
  ['legendary resistance', `${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`],
  ['parry', `${FORGE_CORE}/skills/melee/swords-parry-block-blue.webp`],
  ['shield', `${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`],
  ['evasion', `${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`],
  ['fey ancestry', `${FORGE_CORE}/magic/control/fae-fairy-flower-green.webp`],
  ['indomitable', `${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`],
  ['mask of the wild', `${FORGE_CORE}/skills/social/intimidation-impressed-yellow.webp`],
  ['vampire weaknesses', `${FORGE_CORE}/magic/time/day-night-sunset-sunrise.webp`],

  // Offensive / multiattack family (verified: Multiattack + Pack Tactics)
  ['multiattack', `${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`],
  ['pack tactics', `${FORGE_CORE}/creatures/abilities/wolf-heads-swirl-purple.webp`],
  ['savage', `${FORGE_CORE}/creatures/abilities/fangs-teeth-bite.webp`],
  ['frenzy', `${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`],
  ['bloodlust', `${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`],
  ['blood frenzy', `${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`],
  ['reckless', `${FORGE_CORE}/skills/melee/strike-axe-light-orange.webp`],

  // Natural attacks (verified: Bite + Claws from monsterfeatures24)
  ['bite', `${FORGE_CORE}/creatures/abilities/fangs-teeth-bite.webp`],
  ['claws', `${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`],
  ['claw', `${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`],
  ['gore', `${FORGE_CORE}/creatures/abilities/fangs-teeth-bite.webp`],
  ['tail', `${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`],
  ['stinger', `${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`],
  ['constrict', `${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`],

  // Breath / area (verified: Acid Breath from monsterfeatures24)
  ['breath weapon', `${FORGE_CORE}/magic/acid/projectile-stream-bubbles.webp`],
  ['acid breath', `${FORGE_CORE}/magic/acid/projectile-stream-bubbles.webp`],
  ['fire breath', `${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`],
  ['cold breath', `${FORGE_CORE}/magic/water/wave-water-blue.webp`],
  ['lightning breath', `${FORGE_CORE}/magic/lightning/bolt-strike-blue.webp`],
  ['poison breath', `${FORGE_CORE}/magic/death/skull-poison-green.webp`],

  // Charm / fear / mental (verified: Frightful Presence)
  ['charm', `${FORGE_CORE}/magic/control/fae-fairy-flower-green.webp`],
  ['frightful presence', `${FORGE_CORE}/magic/unholy/silhouette-robe-evil-glow.webp`],
  ['psychic scream', `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`],
  ['screams of the dead', `${FORGE_CORE}/magic/unholy/silhouette-robe-evil-glow.webp`],

  // Status / control / restraints (verified: world Volenta TangleFoot)
  ['paralysis', `${FORGE_CORE}/magic/control/voodoo-doll-pain-purple.webp`],
  ['paralyzing', `${FORGE_CORE}/magic/control/voodoo-doll-pain-purple.webp`],
  ['petrify', `${FORGE_CORE}/magic/earth/projectile-boulder-debris.webp`],
  ['web', `${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`],
  ['tanglefoot', `${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`],
  ['grappler', `${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`],

  // Sunlight / light (verified: Sunlight Sensitivity 24 + world Volenta)
  ['sunlight hypersensitivity', `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`],
  ['sunlight sensitivity', `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`],
  ['sunlight', `${FORGE_CORE}/magic/light/explosion-star-glow-orange.webp`],
  ['illumination', `${FORGE_CORE}/magic/light/explosion-star-glow-orange.webp`],

  // Alchemical thrown items (verified: world Volenta scratch-built items)
  ['firebomb', `${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`],
  ['alchemist', `${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`],
  ['thunderstone', `${FORGE_CORE}/magic/earth/projectile-boulder-debris.webp`],
  ['smokestick', `${FORGE_CORE}/magic/air/fog-gas-smoke-dense-brown.webp`],

  // Heal / regen (verified: Regeneration from monsterfeatures24)
  ['regeneration', `${FORGE_CORE}/skills/wounds/injury-stitched-flesh-red.webp`],
  ['second wind', `${FORGE_CORE}/skills/wounds/injury-stitched-flesh-red.webp`],

  // Ranged / close-quarters (verified shape; observed working on Phase 9 actor)
  ['close quarters fighter', `${FORGE_CORE}/skills/ranged/arrow-flying-shaft-orange.webp`],
  ['hail of daggers', `${FORGE_CORE}/skills/ranged/arrow-flying-shaft-orange.webp`],

  // Magic resistance / general resistance
  ['magic resistance', `${FORGE_CORE}/magic/defensive/shield-barrier-glowing-blue.webp`],
  ['resistance', `${FORGE_CORE}/magic/defensive/shield-barrier-glowing-blue.webp`],
  ['ritual', `${FORGE_CORE}/magic/symbols/runes-carved-stone-grey.webp`],
  ['shapechange', `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`],
  ['change shape', `${FORGE_CORE}/magic/control/silhouette-aura-grey.webp`],

  // Sense / detection
  ['blindsight', `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`],
  ['truesight', `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`],
  ['darkvision', `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`],
  ['keen senses', `${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`],
];

/**
 * Resolve an icon path for a feat by name + optional parsed action data.
 * Returns either a full Forge-bazaar URL (Foundry core icon) or a
 * Foundry-relative system path (dnd5e activity icons / fallback).
 *
 * Always returns SOMETHING — falls through to the generic feature icon when
 * no specific match is found. Callers can compare the result against
 * `FEATURE_FALLBACK_PATH` to detect "no themed icon" if they want to chain
 * a Forge-curated lookup as a future enhancement.
 */
export function resolveFeatIcon(name: string, parsed?: ParsedAction | null): string {
  const lower = (name ?? '').toLowerCase();

  for (const [key, path] of NAME_ICON_MAP) {
    if (lower.includes(key)) return path;
  }

  if (parsed) {
    if (parsed.save) return `${DND5E_ACTIVITY}/save.svg`;
    if (parsed.attackBonus !== undefined || parsed.attackType) {
      return `${DND5E_ACTIVITY}/attack.svg`;
    }
    if (parsed.damage && parsed.damage.length > 0) {
      return `${DND5E_ACTIVITY}/damage.svg`;
    }
  }

  return FEATURE_FALLBACK;
}

/** Path returned when nothing in the lookup or heuristics matched. */
export const FEATURE_FALLBACK_PATH = FEATURE_FALLBACK;

/**
 * Default icons we treat as "needs replacement" when the retrofit pass walks
 * an actor. Includes:
 *  - dnd5e's bundled feature icon (the yellow star)
 *  - Foundry core item-bag / mystery-man (generic stand-ins)
 *  - The earlier-Phase-9 broken `abilities/*.svg` paths (so retrofitting an
 *    actor built between the first Phase 9 commit and this fix can recover)
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
  'systems/dnd5e/icons/svg/abilities/web.svg',
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
]);
