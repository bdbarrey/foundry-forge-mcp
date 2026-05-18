// Phase 0 (Arc H gap-closure plan 2026-05-17) — tests for the canonical
// Reloaded-source → ActorIntent orchestrator. Coverage:
//   1. Minimum-viable statblock → top-level fields wire through
//   2. Traits → kind classification (registry + description-only fallback)
//   3. Single attack action → ActionIntent attack activity with damage
//   4. Single save action + condition → ActionIntent save activity with effects[]
//   5. Attack-then-save chained → triggers wiring
//   6. Recharge usage → ActionIntent.usage.recharge tuple
//   7. Usage suffix on name → stripUsageSuffix integration
//   8. Senses + speed (hover) → normalized into ActorSensesIntent / ActorSpeedIntent
//   9. Full Leo Dilisnya 1st-form statblock → canonical shape round-trip
//      (regression net for the Arc H Gallows Speaker workload)

import { describe, it, expect } from 'vitest';
import { parseReloadedSource, statblockToIntent, featureToTraitIntent, featureToActionIntent } from './builder.js';
import { parseReloadedStatblock } from '../parsers/reloaded-statblock.js';

// Minimal statblock skeleton — fill in just the section under test.
function buildStatblock(opts: {
  name?: string;
  size?: string;
  type?: string;
  ac?: number;
  hp?: string; // "157 (35d8)"
  speed?: string;
  abilities?: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  senses?: string;
  cr?: string;
  prof?: string;
  traits?: Array<{ name: string; description: string }>;
  actions?: Array<{ name: string; description: string }>;
  bonusActions?: Array<{ name: string; description: string }>;
  reactions?: Array<{ name: string; description: string }>;
}): string {
  const {
    name = 'Test Creature',
    size = 'Medium',
    type = 'humanoid',
    ac = 13,
    hp = '10 (2d8)',
    speed = '30 ft.',
    abilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    senses = 'passive Perception 10',
    cr = 'CR 1',
    prof = '+2',
    traits = [],
    actions = [],
    bonusActions = [],
    reactions = [],
  } = opts;

  const lines: string[] = [];
  lines.push('<div class="statblock">');
  lines.push(`<h2>${name}</h2>`);
  lines.push(`<em>${size} ${type}, neutral</em>`);
  lines.push('<hr>');
  lines.push(`<strong>Armor Class</strong> ${ac}<br>`);
  lines.push(`<strong>Hit Points</strong> ${hp}<br>`);
  lines.push(`<strong>Speed</strong> ${speed}`);
  lines.push('<hr>');
  lines.push('<table class="ability-table"><thead><tr><th>STR</th><th>DEX</th><th>CON</th><th>INT</th><th>WIS</th><th>CHA</th></tr></thead><tbody><tr>');
  for (const ab of [abilities.str, abilities.dex, abilities.con, abilities.int, abilities.wis, abilities.cha]) {
    const mod = Math.floor((ab - 10) / 2);
    const sign = mod >= 0 ? '+' : '';
    lines.push(`<td>${ab} (${sign}${mod})</td>`);
  }
  lines.push('</tr></tbody></table>');
  lines.push('<hr>');
  lines.push(`<strong>Senses</strong> ${senses}<br>`);
  lines.push('<strong>Languages</strong> Common<br>');
  lines.push(`<strong>Challenge</strong> ${cr}<br>`);
  lines.push(`<strong>Proficiency Bonus</strong> ${prof}<br>`);
  lines.push('<hr>');

  for (const t of traits) {
    lines.push(`<p><strong><em>${t.name}.</em></strong> ${t.description}</p>`);
  }

  if (actions.length > 0) {
    lines.push('<h3>Actions</h3>');
    for (const a of actions) {
      lines.push(`<p><strong><em>${a.name}.</em></strong> ${a.description}</p>`);
    }
  }
  if (bonusActions.length > 0) {
    lines.push('<h3>Bonus Actions</h3>');
    for (const a of bonusActions) {
      lines.push(`<p><strong><em>${a.name}.</em></strong> ${a.description}</p>`);
    }
  }
  if (reactions.length > 0) {
    lines.push('<h3>Reactions</h3>');
    for (const a of reactions) {
      lines.push(`<p><strong><em>${a.name}.</em></strong> ${a.description}</p>`);
    }
  }

  lines.push('</div>');
  return lines.join('\n');
}

describe('parseReloadedSource — minimum-viable statblock', () => {
  it('wires top-level identity + AC + HP + abilities + CR', () => {
    const md = buildStatblock({
      name: 'Test Goblin',
      size: 'Small',
      type: 'humanoid',
      ac: 15,
      hp: '7 (2d6)',
      cr: 'CR 1/4',
      prof: '+2',
    });
    const intent = parseReloadedSource(md);
    expect(intent.name).toBe('Test Goblin');
    expect(intent.size).toBe('Small');
    expect(intent.type).toBe('humanoid');
    expect(intent.ac?.value).toBe(15);
    expect(intent.hp?.max).toBe(7);
    expect(intent.hp?.formula).toBe('2d6');
    expect(intent.abilities?.str).toBe(10);
    expect(intent.proficiencyBonus).toBe(2);
    expect(intent.actions).toEqual([]);
    expect(intent.traits).toEqual([]);
  });

  it('emits cr as a number for "CR N" and "CR 1/4" prefixed values (builder strips the prefix)', () => {
    const num = parseReloadedSource(buildStatblock({ cr: 'CR 11' }));
    expect(num.cr).toBe(11);
    const fractional = parseReloadedSource(buildStatblock({ cr: 'CR 1/4' }));
    expect(fractional.cr).toBe(0.25);
  });
});

describe('parseReloadedSource — trait classification', () => {
  it('classifies registered traits via TRAIT_TEMPLATES', () => {
    const md = buildStatblock({
      traits: [
        { name: 'Pack Tactics', description: 'The creature has advantage on attacks if an ally is within 5 feet.' },
        { name: 'Sunlight Hypersensitivity', description: 'The creature takes 20 radiant damage at the start of its turn in sunlight.' },
        { name: 'Regeneration', description: 'The creature regains 10 hit points at the start of its turn.' },
        { name: 'Magic Resistance', description: 'Advantage on saving throws against spells and other magical effects.' },
        { name: 'Awakened Bloodlust', description: 'Pure flavor — no mechanical effect.' },
      ],
    });
    const intent = parseReloadedSource(md);
    expect(intent.traits).toHaveLength(5);
    expect(intent.traits?.[0]?.kind).toBe('pack-tactics');
    expect(intent.traits?.[1]?.kind).toBe('sunlight-hypersensitivity');
    expect(intent.traits?.[2]?.kind).toBe('regeneration');
    expect(intent.traits?.[3]?.kind).toBe('magic-resistance');
    expect(intent.traits?.[4]?.kind).toBe('description-only');
  });

  it('classifies Sunlight Sensitivity distinct from Sunlight Hypersensitivity', () => {
    const md = buildStatblock({
      traits: [
        { name: 'Sunlight Sensitivity', description: 'Disadvantage on attack rolls in sunlight.' },
      ],
    });
    const intent = parseReloadedSource(md);
    expect(intent.traits?.[0]?.kind).toBe('sunlight-sensitivity');
  });
});

describe('parseReloadedSource — single attack action', () => {
  it('emits ActionIntent with attack activity and damage parts', () => {
    const md = buildStatblock({
      actions: [
        {
          name: 'Bite',
          description: '<em>Melee Weapon Attack:</em> +5 to hit, reach 5 ft., one creature. <em>Hit:</em> 7 (1d8 + 3) piercing damage.',
        },
      ],
    });
    const intent = parseReloadedSource(md);
    expect(intent.actions).toHaveLength(1);
    const bite = intent.actions?.[0];
    expect(bite?.name).toBe('Bite');
    expect(bite?.activities).toHaveLength(1);
    expect(bite?.activities[0]?.kind).toBe('attack');
    expect(bite?.activities[0]?.attack?.bonus).toBe(5);
    expect(bite?.activities[0]?.attack?.attackType).toBe('melee');
    expect(bite?.activities[0]?.damage?.parts).toEqual([{ formula: '1d8 + 3', type: 'piercing' }]);
    expect(bite?.activities[0]?.damage?.includeBase).toBe(false);
    expect(bite?.activities[0]?.range?.reach).toBe(5);
  });
});

describe('parseReloadedSource — save action with condition', () => {
  it('emits save activity with damage onSave half and effects.conditionRef linked to conditions[]', () => {
    const md = buildStatblock({
      actions: [
        {
          name: 'Fear Aura',
          description: 'Each creature within 30 feet must succeed on a DC 15 Wisdom saving throw or take 21 (6d6) psychic damage and be frightened until the end of its next turn. On a success, the target takes half damage and isn\'t frightened.',
        },
      ],
    });
    const intent = parseReloadedSource(md);
    const fear = intent.actions?.[0];
    expect(fear?.name).toBe('Fear Aura');
    expect(fear?.conditions).toHaveLength(1);
    expect(fear?.conditions[0]?.type).toBe('frightened');
    const save = fear?.activities[0];
    expect(save?.kind).toBe('save');
    expect(save?.save?.ability).toBe('wis');
    expect(save?.save?.dc).toBe(15);
    expect(save?.save?.onSuccess).toBe('half');
    expect(save?.damage?.parts).toEqual([{ formula: '6d6', type: 'psychic' }]);
    expect(save?.damage?.onSave).toBe('half');
    expect(save?.effects?.[0]?.conditionRef).toBe(0);
    expect(fear?.midiProperties?.saveDamage).toBe('halfdam');
  });
});

describe('parseReloadedSource — chained attack-then-save', () => {
  it('emits save first then attack with triggers.activityRef pointing at the save', () => {
    // Modeled on the Wolf Bite shape: attack hits AND save against prone.
    const md = buildStatblock({
      actions: [
        {
          name: 'Bite',
          description: '<em>Melee Weapon Attack:</em> +4 to hit, reach 5 ft., one target. <em>Hit:</em> 7 (1d6 + 2) piercing damage. If the target is a creature, it must succeed on a DC 11 Strength saving throw or be knocked prone.',
        },
      ],
    });
    const intent = parseReloadedSource(md);
    const bite = intent.actions?.[0];
    expect(bite?.activities).toHaveLength(2);
    // Save first (insertion order matches today's writer).
    expect(bite?.activities[0]?.kind).toBe('save');
    expect(bite?.activities[0]?.intentId).toBe('save');
    expect(bite?.activities[0]?.save?.dc).toBe(11);
    expect(bite?.activities[0]?.save?.ability).toBe('str');
    // Attack second, triggers the save on hit.
    expect(bite?.activities[1]?.kind).toBe('attack');
    expect(bite?.activities[1]?.intentId).toBe('attack');
    expect(bite?.activities[1]?.triggers?.activityRef).toBe('save');
    expect(bite?.activities[1]?.triggers?.targets).toBe('hit');
    // Damage rides the attack (attackBonus is present).
    expect(bite?.activities[1]?.damage?.parts).toEqual([{ formula: '1d6 + 2', type: 'piercing' }]);
    // Condition lives on the save.
    expect(bite?.activities[0]?.effects?.[0]?.conditionRef).toBe(0);
    expect(bite?.conditions[0]?.type).toBe('prone');
  });
});

describe('parseReloadedSource — usage suffix on action name', () => {
  it('strips "(Recharge 5-6)" off the name and emits usage.recharge tuple', () => {
    const md = buildStatblock({
      actions: [
        {
          name: 'Wail (Recharge 5-6)',
          description: 'Each creature within 30 feet must make a DC 13 Wisdom saving throw or be frightened.',
        },
      ],
    });
    const intent = parseReloadedSource(md);
    const wail = intent.actions?.[0];
    expect(wail?.name).toBe('Wail');
    expect(wail?.usage).toEqual({ recharge: [5, 6] });
  });

  it('strips "(1/Day)" off the name and emits usage.count/period', () => {
    const md = buildStatblock({
      actions: [
        {
          name: 'Frightful Presence (1/Day)',
          description: 'Creatures within 30 feet make a DC 15 Wisdom save or be frightened.',
        },
      ],
    });
    const intent = parseReloadedSource(md);
    const fp = intent.actions?.[0];
    expect(fp?.name).toBe('Frightful Presence');
    expect(fp?.usage).toEqual({ count: 1, period: 'day' });
  });
});

describe('parseReloadedSource — senses + speed normalization', () => {
  it('parses darkvision, blindsight, truesight, tremorsense, passive Perception', () => {
    const md = buildStatblock({
      senses: 'darkvision 60 ft., blindsight 30 ft., truesight 120 ft., tremorsense 10 ft., passive Perception 15',
    });
    const intent = parseReloadedSource(md);
    expect(intent.senses?.darkvision).toBe(60);
    expect(intent.senses?.blindsight).toBe(30);
    expect(intent.senses?.truesight).toBe(120);
    expect(intent.senses?.tremorsense).toBe(10);
    expect(intent.senses?.passivePerception).toBe(15);
  });

  it('detects fly + hover from speed text', () => {
    const md = buildStatblock({
      speed: '0 ft., fly 40 ft. (hover)',
    });
    const intent = parseReloadedSource(md);
    expect(intent.speed?.walk).toBe(0);
    expect(intent.speed?.fly).toBe(40);
    expect(intent.speed?.hover).toBe(true);
  });

  it('emits speed without hover when text lacks "(hover)"', () => {
    const md = buildStatblock({
      speed: '30 ft., fly 60 ft.',
    });
    const intent = parseReloadedSource(md);
    expect(intent.speed?.fly).toBe(60);
    expect(intent.speed?.hover).toBeUndefined();
  });
});

describe('parseReloadedSource — Leo Dilisnya 1st form (Arc H regression fixture)', () => {
  // Speaker of the Gallows from CoS Reloaded Arc H. This is the prod statblock
  // the gap-closure plan exists to verify. Asserts:
  //   - 9 actions across action categories
  //   - 3 traits, all description-only (Close Quarters Fighter etc. aren't in the registry)
  //   - Foretelling Touch: attack +8 melee 5ft, 2d10+4 psychic (NOT includeBase=true)
  //   - Lash of Souls: save DC 16 str, 2d8 necrotic onSave:half, restrained
  //   - Wisplight Flare: save DC 16 con, 4d6 radiant onSave:half, blinded — the
  //     statblock that Arc H built as the WRONG shape (attack instead of save).
  //     The parser must classify it as a save.
  const LEO_1ST = `<div class="statblock">
<h2>Speaker of the Gallows</h2>
<em>Medium undead, neutral evil</em>
<hr>
<strong>Armor Class</strong> 13<br>
<strong>Hit Points</strong> 157 (35d8)<br>
<strong>Speed</strong> 0 ft., fly 40 ft. (hover)
<hr>
<table class="ability-table"><thead><tr><th>STR</th><th>DEX</th><th>CON</th><th>INT</th><th>WIS</th><th>CHA</th></tr></thead><tbody><tr><td>8 (-1)</td><td>16 (+3)</td><td>10 (+0)</td><td>10 (+0)</td><td>12 (+1)</td><td>18 (+4)</td></tr></tbody></table>
<hr>
<strong>Saving Throws</strong> Dex +7, Wis +5, Cha +8<br>
<strong>Skills</strong> Perception +5<br>
<strong>Damage Immunities</strong> necrotic, poison<br>
<strong>Condition Immunities</strong> charmed, exhaustion, frightened, grappled, paralyzed, petrified, poisoned, prone, restrained, stunned<br>
<strong>Senses</strong> truesight 60 ft., passive Perception 15<br>
<strong>Languages</strong> Abyssal, Common<br>
<strong>Challenge</strong> CR 11<br>
<strong>Proficiency Bonus</strong> +4<br>
<hr>
<p><strong><em>Close Quarters Fighter.</em></strong> The gallows speaker doesn't have disadvantage on its ranged attack rolls when within 5 feet of a hostile creature.</p>
<p><strong><em>Divination Senses.</em></strong> The gallows speaker can see 60 feet into the Ethereal Plane when it is on the Material Plane and vice versa.</p>
<p><strong><em>Wrath of the Traitor.</em></strong> If the gallows speaker is reduced to 0 hit points, it transforms into the Ba'al Verzi Avenger.</p>
<h3>Actions</h3>
<p><strong><em>Multiattack.</em></strong> The gallows speaker makes two attacks.</p>
<p><strong><em>Foretelling Touch.</em></strong> <em>Melee Spell Attack:</em> +8 to hit, reach 5 ft., one creature. <em>Hit:</em> 15 (2d10 + 4) psychic damage.</p>
<p><strong><em>Will-o'-Wisp.</em></strong> <em>Ranged Spell Attack:</em> +8 to hit, range 30 ft., one creature. <em>Hit:</em> 13 (3d8) necrotic damage.</p>
<p><strong><em>Deathly Visions.</em></strong> The gallows speaker forces a creature within 30 feet to make a DC 16 Wisdom saving throw or be paralyzed until the start of the gallows speaker's next turn.</p>
<h3>Bonus Actions</h3>
<p><strong><em>Lash of Souls.</em></strong> Up to two creatures within 5 feet must succeed on a DC 16 Strength saving throw or take 9 (2d8) necrotic damage and be restrained until the start of the gallows speaker's next turn. On a success, the target takes half damage and isn't restrained.</p>
<p><strong><em>Wisplight Flare.</em></strong> Each creature within 5 feet of a point within 30 feet must succeed on a DC 16 Constitution saving throw or take 14 (4d6) radiant damage and be blinded until the start of the gallows speaker's next turn. On a success, the target takes half damage and isn't blinded.</p>
<h3>Reactions</h3>
<p><strong><em>Indomitable.</em></strong> Trigger: A hostile creature ends its turn. Effect: Repeat a saving throw against one effect or condition currently affecting it.</p>
<p><strong><em>Ghostly Step.</em></strong> In response to taking damage, the gallows speaker teleports up to 15 feet away. Each creature within 5 feet of its new location must succeed on a DC 16 Wisdom saving throw or be frightened until the end of its next turn.</p>
</div>`;

  it('parses all top-level identity + combat fundamentals', () => {
    const intent = parseReloadedSource(LEO_1ST);
    expect(intent.name).toBe('Speaker of the Gallows');
    expect(intent.size).toBe('Medium');
    expect(intent.ac?.value).toBe(13);
    expect(intent.hp?.max).toBe(157);
    expect(intent.hp?.formula).toBe('35d8');
    expect(intent.speed?.fly).toBe(40);
    expect(intent.speed?.hover).toBe(true);
    expect(intent.abilities?.dex).toBe(16);
    expect(intent.abilities?.cha).toBe(18);
    expect(intent.saves?.dex).toBe(7);
    expect(intent.saves?.wis).toBe(5);
    expect(intent.saves?.cha).toBe(8);
    expect(intent.cr).toBe(11);
    expect(intent.proficiencyBonus).toBe(4);
    expect(intent.senses?.truesight).toBe(60);
    expect(intent.senses?.passivePerception).toBe(15);
    expect(intent.damageImmunities).toContain('necrotic');
    expect(intent.damageImmunities).toContain('poison');
    expect(intent.conditionImmunities).toContain('charmed');
    expect(intent.conditionImmunities).toContain('paralyzed');
  });

  it('enumerates all 3 traits as description-only (none in TRAIT_TEMPLATES registry)', () => {
    const intent = parseReloadedSource(LEO_1ST);
    expect(intent.traits).toHaveLength(3);
    const names = intent.traits?.map(t => t.name);
    expect(names).toEqual(['Close Quarters Fighter', 'Divination Senses', 'Wrath of the Traitor']);
    for (const t of intent.traits ?? []) {
      expect(t.kind).toBe('description-only');
    }
  });

  it('enumerates 4 actions (Multiattack + 3 spell attacks/save) at the right shapes', () => {
    const intent = parseReloadedSource(LEO_1ST);
    expect(intent.actions).toHaveLength(4);

    const byName = Object.fromEntries((intent.actions ?? []).map(a => [a.name, a]));

    // Multiattack — description-only, no activities.
    expect(byName['Multiattack']).toBeDefined();
    expect(byName['Multiattack']?.activities).toEqual([]);

    // Foretelling Touch — attack +8 melee 5ft, 2d10+4 psychic.
    const ft = byName['Foretelling Touch'];
    expect(ft?.activities).toHaveLength(1);
    expect(ft?.activities[0]?.kind).toBe('attack');
    expect(ft?.activities[0]?.attack?.bonus).toBe(8);
    expect(ft?.activities[0]?.attack?.attackType).toBe('melee');
    expect(ft?.activities[0]?.range?.reach).toBe(5);
    expect(ft?.activities[0]?.damage?.parts).toEqual([{ formula: '2d10 + 4', type: 'psychic' }]);
    expect(ft?.activities[0]?.damage?.includeBase).toBe(false);

    // Will-o'-Wisp — attack +8 ranged 30ft, 3d8 necrotic.
    const ww = byName["Will-o'-Wisp"];
    expect(ww?.activities[0]?.kind).toBe('attack');
    expect(ww?.activities[0]?.attack?.attackType).toBe('ranged');
    expect(ww?.activities[0]?.range?.value).toBe(30);
    expect(ww?.activities[0]?.damage?.parts).toEqual([{ formula: '3d8', type: 'necrotic' }]);

    // Deathly Visions — save DC 16 wis, no damage, paralyzed condition.
    const dv = byName['Deathly Visions'];
    expect(dv?.activities[0]?.kind).toBe('save');
    expect(dv?.activities[0]?.save?.ability).toBe('wis');
    expect(dv?.activities[0]?.save?.dc).toBe(16);
    expect(dv?.activities[0]?.damage).toBeUndefined();
    expect(dv?.conditions[0]?.type).toBe('paralyzed');
  });

  it('enumerates 2 bonus actions as save-shape — the Wisplight Flare regression case', () => {
    const intent = parseReloadedSource(LEO_1ST);
    expect(intent.bonusActions).toHaveLength(2);
    const byName = Object.fromEntries((intent.bonusActions ?? []).map(a => [a.name, a]));

    // Lash of Souls — save DC 16 str, 2d8 necrotic onSave:half, restrained.
    const ls = byName['Lash of Souls'];
    expect(ls?.activities[0]?.kind).toBe('save');
    expect(ls?.activities[0]?.save?.ability).toBe('str');
    expect(ls?.activities[0]?.save?.dc).toBe(16);
    expect(ls?.activities[0]?.save?.onSuccess).toBe('half');
    expect(ls?.activities[0]?.damage?.parts).toEqual([{ formula: '2d8', type: 'necrotic' }]);
    expect(ls?.activities[0]?.damage?.onSave).toBe('half');
    expect(ls?.conditions[0]?.type).toBe('restrained');

    // Wisplight Flare — THIS is the Arc H regression. Source prose "Each creature
    // within 5 feet of a point within 30 feet must succeed on a DC 16 Constitution
    // saving throw" must parse as save (not attack) with 4d6 radiant onSave:half.
    const wf = byName['Wisplight Flare'];
    expect(wf?.activities[0]?.kind).toBe('save');
    expect(wf?.activities[0]?.save?.ability).toBe('con');
    expect(wf?.activities[0]?.save?.dc).toBe(16);
    expect(wf?.activities[0]?.save?.onSuccess).toBe('half');
    expect(wf?.activities[0]?.damage?.parts).toEqual([{ formula: '4d6', type: 'radiant' }]);
    expect(wf?.activities[0]?.damage?.onSave).toBe('half');
    expect(wf?.conditions[0]?.type).toBe('blinded');
  });

  it('enumerates 2 reactions including Ghostly Step with frightened conditionRef', () => {
    const intent = parseReloadedSource(LEO_1ST);
    expect(intent.reactions).toHaveLength(2);
    const byName = Object.fromEntries((intent.reactions ?? []).map(a => [a.name, a]));

    expect(byName['Indomitable']).toBeDefined();
    expect(byName['Indomitable']?.activities).toEqual([]); // narrative reaction, no save/attack

    const gs = byName['Ghostly Step'];
    expect(gs?.activities[0]?.kind).toBe('save');
    expect(gs?.activities[0]?.save?.ability).toBe('wis');
    expect(gs?.activities[0]?.save?.dc).toBe(16);
    expect(gs?.conditions[0]?.type).toBe('frightened');
  });
});

describe('statblockToIntent — separately callable for pre-parsed ReloadedStatblock', () => {
  it('produces the same intent as parseReloadedSource when given the equivalent parsed input', () => {
    const md = buildStatblock({ name: 'Pre-parsed' });
    const fromString = parseReloadedSource(md);
    const sb = parseReloadedStatblock(md);
    const fromParsed = statblockToIntent(sb);
    expect(fromParsed).toEqual(fromString);
  });
});

describe('featureToActionIntent / featureToTraitIntent — exported helpers', () => {
  it('featureToActionIntent strips usage suffix and routes to parsedActionToIntent', () => {
    const sb = parseReloadedStatblock(
      buildStatblock({
        actions: [
          {
            name: 'Wail (Recharge 5-6)',
            description: 'Each creature within 30 feet must make a DC 13 Wisdom saving throw or be frightened until the start of its next turn.',
          },
        ],
      }),
    );
    const intent = featureToActionIntent(sb.actions[0]!);
    expect(intent.name).toBe('Wail');
    expect(intent.usage).toEqual({ recharge: [5, 6] });
    expect(intent.activities[0]?.kind).toBe('save');
  });

  it('featureToTraitIntent classifies by registry + falls back to description-only', () => {
    const sb = parseReloadedStatblock(
      buildStatblock({
        traits: [
          { name: 'Pack Tactics', description: 'Advantage on attacks if an ally is within 5 feet.' },
          { name: 'Some Custom Trait', description: 'Flavor.' },
        ],
      }),
    );
    expect(featureToTraitIntent(sb.traits[0]!).kind).toBe('pack-tactics');
    expect(featureToTraitIntent(sb.traits[1]!).kind).toBe('description-only');
  });
});
