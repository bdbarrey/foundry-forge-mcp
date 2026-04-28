// Phase 9: feat-icons.
//
// Reloaded-only traits + scratch-built actions land with dnd5e's generic
// feature icon (the yellow star) because we don't set `img` when adding
// items via addActorItems. This resolver picks a reasonable themed icon
// from the dnd5e system's bundled SVG library based on the feat's name and
// parsed combat data.
//
// dnd5e ships the abilities/ + activity/ SVG sets as part of the system
// install — they're guaranteed-safe paths under `systems/dnd5e/icons/svg/`.
// Non-system icon paths (Foundry core `icons/...`, Forge `cos-feat-icons`)
// are deferred until a curated library exists.
//
// Resolution order:
//   1. Curated NAME table (case-insensitive substring match) — wins for
//      common monster traits like Multiattack, Regeneration, Spider Climb,
//      Pack Tactics, Sunlight Hypersensitivity, etc.
//   2. Combat-shape heuristics off ParsedAction — has save → save icon;
//      has attack → attack icon; has damage → damage icon.
//   3. Generic feature fallback — better than the star but signals "no
//      themed icon found" so a future curated library can target this case.

import type { ParsedAction } from '../parsers/action-description.js';

const ABILITY_BASE = 'systems/dnd5e/icons/svg/abilities';
const ACTIVITY_BASE = 'systems/dnd5e/icons/svg/activity';
const FEATURE_FALLBACK = 'systems/dnd5e/icons/svg/items/feature.svg';

/**
 * Curated name → icon table. Keys are lowercase fragments matched as
 * substrings against the feat name (so "Sunlight Hypersensitivity" hits
 * the "sunlight" entry; "Greater Pack Tactics" hits "pack tactics").
 *
 * Order matters: longer keys must be listed before shorter ones if both
 * could match the same feat name. The lookup walks entries in declaration
 * order and returns the first hit.
 */
const NAME_ICON_MAP: ReadonlyArray<readonly [string, string]> = [
  // Spellcasting
  ['innate spellcasting', `${ABILITY_BASE}/pact-magic.svg`],
  ['spellcasting', `${ABILITY_BASE}/pact-magic.svg`],

  // Movement / escape
  ['misty escape', `${ABILITY_BASE}/vanish.svg`],
  ['misty step', `${ABILITY_BASE}/vanish.svg`],
  ['nimble escape', `${ABILITY_BASE}/stealthy.svg`],
  ['vanish', `${ABILITY_BASE}/vanish.svg`],
  ['hide', `${ABILITY_BASE}/stealthy.svg`],
  ['stealth', `${ABILITY_BASE}/stealthy.svg`],
  ['leap', `${ABILITY_BASE}/agility.svg`],
  ['spider climb', `${ABILITY_BASE}/agility.svg`],
  ['climb', `${ABILITY_BASE}/agility.svg`],
  ['hover', `${ABILITY_BASE}/hover.svg`],
  ['flyby', `${ABILITY_BASE}/hover.svg`],
  ['swim', `${ABILITY_BASE}/swim.svg`],

  // Defensive
  ['legendary resistance', `${ABILITY_BASE}/special.svg`],
  ['parry', `${ABILITY_BASE}/parry.svg`],
  ['shield', `${ABILITY_BASE}/shield.svg`],
  ['evasion', `${ABILITY_BASE}/agility.svg`],
  ['fey ancestry', `${ABILITY_BASE}/charm.svg`],
  ['indomitable', `${ABILITY_BASE}/special.svg`],
  ['mask of the wild', `${ABILITY_BASE}/stealthy.svg`],

  // Offensive / multiattack family
  ['multiattack', `${ABILITY_BASE}/multiattack.svg`],
  ['pack tactics', `${ABILITY_BASE}/multiattack.svg`],
  ['cleave', `${ABILITY_BASE}/cleave.svg`],
  ['charge', `${ABILITY_BASE}/charge.svg`],
  ['savage', `${ABILITY_BASE}/savage.svg`],
  ['frenzy', `${ABILITY_BASE}/frenzy.svg`],
  ['bloodlust', `${ABILITY_BASE}/frenzy.svg`],
  ['blood frenzy', `${ABILITY_BASE}/frenzy.svg`],

  // Natural attacks
  ['bite', `${ABILITY_BASE}/savage.svg`],
  ['claws', `${ABILITY_BASE}/claw.svg`],
  ['claw', `${ABILITY_BASE}/claw.svg`],
  ['gore', `${ABILITY_BASE}/gore.svg`],
  ['tail', `${ABILITY_BASE}/savage.svg`],
  ['stinger', `${ABILITY_BASE}/savage.svg`],
  ['constrict', `${ABILITY_BASE}/savage.svg`],

  // Breath / area
  ['breath weapon', `${ABILITY_BASE}/breath-weapon.svg`],
  ['fire breath', `${ABILITY_BASE}/breath-weapon.svg`],
  ['cold breath', `${ABILITY_BASE}/breath-weapon.svg`],
  ['lightning breath', `${ABILITY_BASE}/breath-weapon.svg`],
  ['poison breath', `${ABILITY_BASE}/breath-weapon.svg`],
  ['acid breath', `${ABILITY_BASE}/breath-weapon.svg`],

  // Charm / fear / mental
  ['charm', `${ABILITY_BASE}/charm.svg`],
  ['frightful presence', `${ABILITY_BASE}/charm.svg`],
  ['psychic scream', `${ABILITY_BASE}/charm.svg`],

  // Status / control
  ['paralysis', `${ABILITY_BASE}/paralysis.svg`],
  ['paralyzing', `${ABILITY_BASE}/paralysis.svg`],
  ['petrify', `${ABILITY_BASE}/paralysis.svg`],
  ['web', `${ABILITY_BASE}/web.svg`],
  ['tanglefoot', `${ABILITY_BASE}/web.svg`],
  ['grappler', `${ABILITY_BASE}/web.svg`],

  // Sunlight / light / fire
  ['sunlight hypersensitivity', `${ABILITY_BASE}/sunlight.svg`],
  ['sunlight sensitivity', `${ABILITY_BASE}/sunlight.svg`],
  ['sunlight', `${ABILITY_BASE}/sunlight.svg`],
  ['illumination', `${ABILITY_BASE}/illumination.svg`],
  ['firebomb', `${ABILITY_BASE}/breath-weapon.svg`],
  ['alchemist', `${ABILITY_BASE}/breath-weapon.svg`],

  // Heal / regen
  ['regeneration', `${ABILITY_BASE}/regenerate.svg`],
  ['second wind', `${ABILITY_BASE}/second-wind.svg`],

  // Ranged-specific
  ['close quarters fighter', `${ABILITY_BASE}/ranged-attack.svg`],
  ['hail of daggers', `${ABILITY_BASE}/ranged-attack.svg`],

  // Sense / detection
  ['blindsight', `${ABILITY_BASE}/sense.svg`],
  ['truesight', `${ABILITY_BASE}/sense.svg`],
  ['darkvision', `${ABILITY_BASE}/sense.svg`],
  ['keen senses', `${ABILITY_BASE}/sense.svg`],
  ['screams of the dead', `${ABILITY_BASE}/charm.svg`],

  // Generic categories (lowest-priority name hits)
  ['resistance', `${ABILITY_BASE}/resistance.svg`],
  ['ritual', `${ABILITY_BASE}/ritual.svg`],
  ['shape', `${ABILITY_BASE}/change-shape.svg`],
  ['shapechange', `${ABILITY_BASE}/change-shape.svg`],
];

/**
 * Resolve an icon path for a feat by name + optional parsed action data.
 * Returns a Foundry-relative path under `systems/dnd5e/icons/svg/...`.
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
    if (parsed.save) return `${ACTIVITY_BASE}/save.svg`;
    if (parsed.attackBonus !== undefined || parsed.attackType) {
      return parsed.attackType === 'ranged'
        ? `${ABILITY_BASE}/ranged-attack.svg`
        : `${ABILITY_BASE}/melee-attack.svg`;
    }
    if (parsed.damage && parsed.damage.length > 0) {
      return `${ACTIVITY_BASE}/damage.svg`;
    }
  }

  return FEATURE_FALLBACK;
}

/** Path returned when nothing in the lookup or heuristics matched. */
export const FEATURE_FALLBACK_PATH = FEATURE_FALLBACK;

/**
 * dnd5e's bundled default for new feat items. Used to detect whether an
 * existing item still has the system default ("nothing was customized") so
 * the retrofit pass can skip items the user has already themed.
 */
export const DND5E_DEFAULT_FEAT_ICONS: ReadonlySet<string> = new Set([
  'systems/dnd5e/icons/svg/items/feature.svg',
  'icons/svg/item-bag.svg',
  'icons/svg/mystery-man.svg',
  // Foundry's hourglass / generic that often gets stuck on scratch-built items.
  'icons/svg/clockwork.svg',
]);
