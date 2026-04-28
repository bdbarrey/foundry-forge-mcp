import { describe, it, expect } from 'vitest';
import { resolveFeatIcon, FEATURE_FALLBACK_PATH, DND5E_DEFAULT_FEAT_ICONS } from './feat-icons.js';

const FORGE_CORE = 'https://assets.forge-vtt.com/bazaar/core/icons';
const DND5E_ACTIVITY = 'systems/dnd5e/icons/svg/activity';

describe('resolveFeatIcon — name-table hits', () => {
  it('multiattack → strike-weapons (verified path from Multiattack 24)', () => {
    expect(resolveFeatIcon('Multiattack')).toBe(`${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`);
  });

  it('pack tactics → wolf-heads (verified path from Pack Tactics 24)', () => {
    expect(resolveFeatIcon('Pack Tactics')).toBe(`${FORGE_CORE}/creatures/abilities/wolf-heads-swirl-purple.webp`);
    expect(resolveFeatIcon('Greater Pack Tactics')).toBe(`${FORGE_CORE}/creatures/abilities/wolf-heads-swirl-purple.webp`);
  });

  it('regeneration → injury-stitched (verified path from Regeneration 24)', () => {
    expect(resolveFeatIcon('Regeneration')).toBe(`${FORGE_CORE}/skills/wounds/injury-stitched-flesh-red.webp`);
  });

  it('sunlight family all map to humanoid-single-blind (verified)', () => {
    expect(resolveFeatIcon('Sunlight Hypersensitivity')).toBe(`${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`);
    expect(resolveFeatIcon('Sunlight Sensitivity')).toBe(`${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`);
  });

  it('volenta-specific items map to themed icons', () => {
    expect(resolveFeatIcon('Tanglefoot')).toBe(`${FORGE_CORE}/magic/nature/root-vine-entangle-foot-green.webp`);
    expect(resolveFeatIcon("Alchemist's Firebomb")).toBe(`${FORGE_CORE}/magic/fire/explosion-mushroom-nuke-orange.webp`);
    expect(resolveFeatIcon('Hail of Daggers')).toBe(`${FORGE_CORE}/skills/ranged/arrow-flying-shaft-orange.webp`);
    expect(resolveFeatIcon('Smokestick')).toBe(`${FORGE_CORE}/magic/air/fog-gas-smoke-dense-brown.webp`);
    expect(resolveFeatIcon('Thunderstone')).toBe(`${FORGE_CORE}/magic/earth/projectile-boulder-debris.webp`);
  });

  it('movement / escape family', () => {
    expect(resolveFeatIcon('Misty Escape')).toBe(`${FORGE_CORE}/magic/movement/door-frame-glow-blue.webp`);
    expect(resolveFeatIcon('Spider Climb')).toBe(`${FORGE_CORE}/creatures/invertebrates/spider-pink-purple.webp`);
    expect(resolveFeatIcon('Nimble Escape')).toBe(`${FORGE_CORE}/skills/movement/ball-spinning-blue.webp`);
  });

  it('case-insensitive substring matching', () => {
    expect(resolveFeatIcon('SUNLIGHT HYPERSENSITIVITY')).toBe(`${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`);
    expect(resolveFeatIcon('greater Multiattack')).toBe(`${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`);
  });

  it('blood frenzy hits frenzy entry', () => {
    expect(resolveFeatIcon('Blood Frenzy')).toBe(`${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`);
    expect(resolveFeatIcon('Awakened Bloodlust')).toBe(`${FORGE_CORE}/skills/wounds/blood-spurt-spray-red.webp`);
  });

  it('legendary resistance + parry + bite + claws all use verified paths', () => {
    expect(resolveFeatIcon('Legendary Resistance (3/Day)'))
      .toBe(`${FORGE_CORE}/equipment/shield/heater-steel-crystal-red.webp`);
    expect(resolveFeatIcon('Parry')).toBe(`${FORGE_CORE}/skills/melee/swords-parry-block-blue.webp`);
    expect(resolveFeatIcon('Bite')).toBe(`${FORGE_CORE}/creatures/abilities/fangs-teeth-bite.webp`);
    expect(resolveFeatIcon('Claws')).toBe(`${FORGE_CORE}/creatures/claws/claw-curved-jagged-gray.webp`);
  });
});

describe('resolveFeatIcon — combat-shape heuristics (no name hit)', () => {
  it('save-having item gets dnd5e save activity icon', () => {
    const parsed = { damage: [], save: { dc: 14, ability: 'str' as const } };
    expect(resolveFeatIcon('Made-Up Trap', parsed)).toBe(`${DND5E_ACTIVITY}/save.svg`);
  });

  it('attack-having item (any attackType) gets dnd5e attack activity icon', () => {
    const parsedRanged = { damage: [], attackBonus: 7, attackType: 'ranged' as const };
    const parsedMelee = { damage: [], attackBonus: 7, attackType: 'melee' as const };
    expect(resolveFeatIcon('Made-Up Bolt', parsedRanged)).toBe(`${DND5E_ACTIVITY}/attack.svg`);
    expect(resolveFeatIcon('Made-Up Strike', parsedMelee)).toBe(`${DND5E_ACTIVITY}/attack.svg`);
  });

  it('damage-only (no attack, no save) gets dnd5e damage activity icon', () => {
    const parsed = { damage: [{ formula: '2d6', type: 'fire' }] };
    expect(resolveFeatIcon('Made-Up Aura', parsed)).toBe(`${DND5E_ACTIVITY}/damage.svg`);
  });

  it('name match wins over heuristics (Sunlight + save → still humanoid-blind)', () => {
    const parsed = { damage: [], save: { dc: 10, ability: 'con' as const } };
    expect(resolveFeatIcon('Sunlight Sensitivity', parsed))
      .toBe(`${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`);
  });
});

describe('resolveFeatIcon — fallback', () => {
  it('returns the generic feature icon when no name hit and no parsed shape', () => {
    expect(resolveFeatIcon('Some Made-Up Trait Nobody Ever Heard Of')).toBe(FEATURE_FALLBACK_PATH);
  });

  it('returns the fallback for empty name + no parsed', () => {
    expect(resolveFeatIcon('')).toBe(FEATURE_FALLBACK_PATH);
  });
});

describe('DND5E_DEFAULT_FEAT_ICONS', () => {
  it('includes the dnd5e generic feature icon (the "yellow star")', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/items/feature.svg')).toBe(true);
  });

  it('includes Foundry core item-bag and mystery-man as known generic stand-ins', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has('icons/svg/item-bag.svg')).toBe(true);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('icons/svg/mystery-man.svg')).toBe(true);
  });

  it('includes stale dnd5e 4.x abilities paths so retrofit can recover broken-icon items', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/web.svg')).toBe(true);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/multiattack.svg')).toBe(true);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/frenzy.svg')).toBe(true);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/ranged-attack.svg')).toBe(true);
  });

  it('does NOT include any new themed bazaar URL (those are replacements, not defaults)', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has(`${FORGE_CORE}/skills/melee/strike-weapons-orange.webp`)).toBe(false);
    expect(DND5E_DEFAULT_FEAT_ICONS.has(`${FORGE_CORE}/creatures/eyes/humanoid-single-blind.webp`)).toBe(false);
  });
});
