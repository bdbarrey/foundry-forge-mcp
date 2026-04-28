import { describe, it, expect } from 'vitest';
import { resolveFeatIcon, FEATURE_FALLBACK_PATH, DND5E_DEFAULT_FEAT_ICONS } from './feat-icons.js';

describe('resolveFeatIcon — name-table hits', () => {
  it('multiattack → multiattack icon (also covers Pack Tactics)', () => {
    expect(resolveFeatIcon('Multiattack')).toBe('systems/dnd5e/icons/svg/abilities/multiattack.svg');
    expect(resolveFeatIcon('Pack Tactics')).toBe('systems/dnd5e/icons/svg/abilities/multiattack.svg');
  });

  it('regeneration → regenerate icon', () => {
    expect(resolveFeatIcon('Regeneration')).toBe('systems/dnd5e/icons/svg/abilities/regenerate.svg');
  });

  it('sunlight family all map to the same sunlight icon', () => {
    expect(resolveFeatIcon('Sunlight Hypersensitivity')).toBe('systems/dnd5e/icons/svg/abilities/sunlight.svg');
    expect(resolveFeatIcon('Sunlight Sensitivity')).toBe('systems/dnd5e/icons/svg/abilities/sunlight.svg');
  });

  it('volenta-specific items map to themed icons', () => {
    expect(resolveFeatIcon('Tanglefoot')).toBe('systems/dnd5e/icons/svg/abilities/web.svg');
    expect(resolveFeatIcon("Alchemist's Firebomb")).toBe('systems/dnd5e/icons/svg/abilities/breath-weapon.svg');
    expect(resolveFeatIcon('Hail of Daggers')).toBe('systems/dnd5e/icons/svg/abilities/ranged-attack.svg');
  });

  it('movement / escape family', () => {
    expect(resolveFeatIcon('Misty Escape')).toBe('systems/dnd5e/icons/svg/abilities/vanish.svg');
    expect(resolveFeatIcon('Spider Climb')).toBe('systems/dnd5e/icons/svg/abilities/agility.svg');
    expect(resolveFeatIcon('Nimble Escape')).toBe('systems/dnd5e/icons/svg/abilities/stealthy.svg');
  });

  it('case-insensitive substring matching', () => {
    expect(resolveFeatIcon('SUNLIGHT HYPERSENSITIVITY')).toBe('systems/dnd5e/icons/svg/abilities/sunlight.svg');
    expect(resolveFeatIcon('Greater Pack Tactics')).toBe('systems/dnd5e/icons/svg/abilities/multiattack.svg');
  });

  it('blood frenzy hits frenzy entry', () => {
    expect(resolveFeatIcon('Blood Frenzy')).toBe('systems/dnd5e/icons/svg/abilities/frenzy.svg');
    expect(resolveFeatIcon('Awakened Bloodlust')).toBe('systems/dnd5e/icons/svg/abilities/frenzy.svg');
  });
});

describe('resolveFeatIcon — combat-shape heuristics (no name hit)', () => {
  it('save-having item gets the save activity icon', () => {
    const parsed = { damage: [], save: { dc: 14, ability: 'str' as const } };
    expect(resolveFeatIcon('Made-Up Trap', parsed)).toBe('systems/dnd5e/icons/svg/activity/save.svg');
  });

  it('attack-having item with explicit ranged attackType gets ranged-attack', () => {
    const parsed = { damage: [], attackBonus: 7, attackType: 'ranged' as const };
    expect(resolveFeatIcon('Made-Up Bolt', parsed)).toBe('systems/dnd5e/icons/svg/abilities/ranged-attack.svg');
  });

  it('attack-having item with melee/no attackType gets melee-attack', () => {
    const parsed = { damage: [], attackBonus: 7, attackType: 'melee' as const };
    expect(resolveFeatIcon('Made-Up Strike', parsed)).toBe('systems/dnd5e/icons/svg/abilities/melee-attack.svg');
  });

  it('damage-only (no attack, no save) gets the damage activity icon', () => {
    const parsed = { damage: [{ formula: '2d6', type: 'fire' }] };
    expect(resolveFeatIcon('Made-Up Aura', parsed)).toBe('systems/dnd5e/icons/svg/activity/damage.svg');
  });
});

describe('resolveFeatIcon — fallback', () => {
  it('returns the generic feature icon when no name hit and no parsed shape', () => {
    expect(resolveFeatIcon('Some Made-Up Trait Nobody Ever Heard Of')).toBe(FEATURE_FALLBACK_PATH);
  });

  it('returns the fallback for empty name + no parsed', () => {
    expect(resolveFeatIcon('')).toBe(FEATURE_FALLBACK_PATH);
  });

  it('name match wins over heuristics (sunlight + save → still sunlight)', () => {
    const parsed = { damage: [], save: { dc: 10, ability: 'con' as const } };
    expect(resolveFeatIcon('Sunlight Sensitivity', parsed))
      .toBe('systems/dnd5e/icons/svg/abilities/sunlight.svg');
  });
});

describe('DND5E_DEFAULT_FEAT_ICONS', () => {
  it('includes the dnd5e generic feature icon (the "yellow star" everyone wants gone)', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/items/feature.svg')).toBe(true);
  });

  it('includes Foundry core item-bag and mystery-man as known generic stand-ins', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has('icons/svg/item-bag.svg')).toBe(true);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('icons/svg/mystery-man.svg')).toBe(true);
  });

  it('does NOT include any specific themed icon (resolver replacements)', () => {
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/multiattack.svg')).toBe(false);
    expect(DND5E_DEFAULT_FEAT_ICONS.has('systems/dnd5e/icons/svg/abilities/sunlight.svg')).toBe(false);
  });
});
