// Phase 12.1.2 tests: ActorIntent → ReloadedStatblock adapter +
// ActorIntentSchema (Zod) acceptance.
//
// The adapter is the sole bridge between Mode E inputs and the existing
// Phase 0-11 build pipeline (chunked-overrides, trait/action add). Tests
// verify the synthetic statblock has the right field shapes so downstream
// chunk-builders work unchanged.

import { describe, it, expect } from 'vitest';
import { actorIntentToReloadedStatblock, actorIntentMask } from './actor-intent-adapter.js';
import { ActorIntentSchema } from './intent-schema.js';
import type { ActorIntent } from './activity-intent.js';

describe('Phase 12.1.2 — actorIntentToReloadedStatblock adapter', () => {
  it('synthesizes minimal sb from a name-only intent (defaults applied)', () => {
    const intent: ActorIntent = { name: 'Test Creature' };
    const sb = actorIntentToReloadedStatblock(intent);

    expect(sb.name).toBe('Test Creature');
    expect(sb.size).toBe('Medium');
    expect(sb.type).toBe('Humanoid');
    expect(sb.alignment).toBe('');
    expect(sb.ac).toBe(10);
    expect(sb.hp.avg).toBe(1);
    expect(sb.hp.formula).toBeNull();
    // walk:0 default keeps downstream chunk builder consistent
    expect(sb.speed).toEqual({ walk: 0 });
    // All abilities default to 10 (mod 0)
    expect(sb.abilities.str).toEqual({ score: 10, mod: 0 });
    expect(sb.abilities.cha).toEqual({ score: 10, mod: 0 });
    expect(sb.traits).toEqual([]);
    expect(sb.actions).toEqual([]);
  });

  it('maps full Vampire-Spawn-shape intent to canonical sb', () => {
    const intent: ActorIntent = {
      name: 'Vampire Spawn',
      base: { packId: 'dnd5e.monsters', itemId: 'vampire-spawn-id' },
      size: 'Medium',
      type: 'Undead',
      alignment: 'Neutral Evil',
      ac: { value: 15, note: 'natural armor' },
      hp: { max: 82, formula: '11d8 + 33' },
      speed: { walk: 30 },
      abilities: { str: 16, dex: 16, con: 16, int: 11, wis: 10, cha: 12 },
      saves: { dex: 6, wis: 3 },
      skills: { perception: 3, stealth: 6 },
      senses: { darkvision: 60, passivePerception: 13 },
      damageResistances: ['necrotic', 'bludgeoning, piercing, and slashing from nonmagical attacks'],
      conditionImmunities: ['charmed'],
      languages: ['the languages it knew in life'],
      cr: 5,
      proficiencyBonus: 3,
    };
    const sb = actorIntentToReloadedStatblock(intent);

    expect(sb.ac).toBe(15);
    expect(sb.acNote).toBe('natural armor');
    expect(sb.hp).toEqual({ avg: 82, formula: '11d8 + 33' });
    expect(sb.speed).toEqual({ walk: 30 });
    expect(sb.abilities.str).toEqual({ score: 16, mod: 3 });
    expect(sb.abilities.dex).toEqual({ score: 16, mod: 3 });
    expect(sb.abilities.con).toEqual({ score: 16, mod: 3 });
    expect(sb.abilities.cha).toEqual({ score: 12, mod: 1 });
    // Saves keys retained for proficiency assertion downstream
    expect(Object.keys(sb.saves).sort()).toEqual(['dex', 'wis']);
    expect(sb.skills).toEqual({ perception: 3, stealth: 6 });
    expect(sb.sensesText).toBe('darkvision 60 ft., passive Perception 13');
    expect(sb.passivePerception).toBe(13);
    expect(sb.damageResistances).toBe(
      'necrotic, bludgeoning, piercing, and slashing from nonmagical attacks',
    );
    expect(sb.damageImmunities).toBeNull();
    expect(sb.conditionImmunities).toBe('charmed');
    expect(sb.languages).toBe('the languages it knew in life');
    expect(sb.challenge).toBe('5');
    expect(sb.challengeNumeric).toBe(5);
    expect(sb.proficiencyBonus).toBe(3);
  });

  it('parses fractional CR strings to challengeNumeric', () => {
    expect(actorIntentToReloadedStatblock({ name: 'X', cr: '1/4' }).challengeNumeric).toBe(0.25);
    expect(actorIntentToReloadedStatblock({ name: 'X', cr: '1/8' }).challengeNumeric).toBe(0.125);
    expect(actorIntentToReloadedStatblock({ name: 'X', cr: '1/2' }).challengeNumeric).toBe(0.5);
    // Qualified strings keep printed form, parse leading number.
    const sb = actorIntentToReloadedStatblock({ name: 'X', cr: '21, or 19 in sunlight' });
    expect(sb.challenge).toBe('21, or 19 in sunlight');
    expect(sb.challengeNumeric).toBe(21);
  });

  it('joins damage trait arrays with comma-space', () => {
    const sb = actorIntentToReloadedStatblock({
      name: 'Multi-resist',
      damageImmunities: ['poison', 'psychic'],
      damageVulnerabilities: ['radiant'],
      conditionImmunities: ['poisoned', 'unconscious'],
    });
    expect(sb.damageImmunities).toBe('poison, psychic');
    expect(sb.damageVulnerabilities).toBe('radiant');
    expect(sb.conditionImmunities).toBe('poisoned, unconscious');
  });

  it('renders sensesText in canonical order matching parseSenses input', () => {
    const sb = actorIntentToReloadedStatblock({
      name: 'X',
      senses: { darkvision: 60, blindsight: 30, passivePerception: 14 },
    });
    expect(sb.sensesText).toBe('darkvision 60 ft., blindsight 30 ft., passive Perception 14');
  });

  it('passes through traits + actions as feature stubs (parsed: empty)', () => {
    const sb = actorIntentToReloadedStatblock({
      name: 'X',
      traits: [
        { kind: 'pack-tactics', name: 'Pack Tactics', description: '' },
        {
          kind: 'custom',
          name: 'Magic Resistance',
          description: 'Advantage on magic saves.',
          custom: { changes: [{ key: 'flags.midi-qol.magicResistance', value: '1' }] },
        },
      ],
      actions: [
        {
          name: 'Bite',
          description: 'Bite description prose.',
          activities: [],
          conditions: [],
        },
      ],
      reactions: [
        {
          name: 'Parry',
          description: 'Parry prose.',
          activities: [],
          conditions: [],
        },
      ],
    });

    expect(sb.traits.map(t => t.name)).toEqual(['Pack Tactics', 'Magic Resistance']);
    expect(sb.traits[0].description).toBe('');
    expect(sb.traits[0].parsed).toEqual({ damage: [] });

    expect(sb.actions.map(a => a.name)).toEqual(['Bite']);
    expect(sb.actions[0].description).toBe('Bite description prose.');
    expect(sb.reactions.map(a => a.name)).toEqual(['Parry']);
  });

  it('handles all five action categories independently', () => {
    const sb = actorIntentToReloadedStatblock({
      name: 'X',
      actions: [{ name: 'A', description: '', activities: [], conditions: [] }],
      bonusActions: [{ name: 'BA', description: '', activities: [], conditions: [] }],
      reactions: [{ name: 'R', description: '', activities: [], conditions: [] }],
      legendaryActions: [{ name: 'L', description: '', activities: [], conditions: [] }],
      lairActions: [{ name: 'Lair', description: '', activities: [], conditions: [] }],
    });
    expect(sb.actions[0].name).toBe('A');
    expect(sb.bonusActions[0].name).toBe('BA');
    expect(sb.reactions[0].name).toBe('R');
    expect(sb.legendaryActions[0].name).toBe('L');
    expect(sb.lairActions[0].name).toBe('Lair');
  });
});

describe('Phase 12.1.2 — ActorIntentSchema (Zod) acceptance', () => {
  it('accepts a name-only minimal intent', () => {
    expect(ActorIntentSchema.safeParse({ name: 'X' }).success).toBe(true);
  });

  it('accepts a Vampire-Spawn-shape full intent with nested ActionIntent', () => {
    const result = ActorIntentSchema.safeParse({
      name: 'Vampire Spawn',
      base: { packId: 'dnd5e.monsters', itemId: 'vampire-spawn' },
      size: 'Medium',
      type: 'Undead',
      alignment: 'Neutral Evil',
      ac: { value: 15, note: 'natural armor' },
      hp: { max: 82, formula: '11d8 + 33' },
      speed: { walk: 30 },
      abilities: { str: 16, dex: 16, con: 16, int: 11, wis: 10, cha: 12 },
      saves: { dex: 6, wis: 3 },
      skills: { perception: 3, stealth: 6 },
      senses: { darkvision: 60, passivePerception: 13 },
      damageResistances: ['necrotic'],
      conditionImmunities: ['charmed'],
      languages: ['Common'],
      cr: 5,
      proficiencyBonus: 3,
      traits: [
        {
          kind: 'custom',
          name: 'Regeneration',
          description: '...',
          custom: {
            changes: [{ key: 'flags.midi-qol.regeneration', value: '10' }],
          },
        },
      ],
      actions: [
        {
          name: 'Bite',
          description: '...',
          activities: [
            {
              intentId: 'attack',
              kind: 'attack',
              name: 'Attack',
              attack: { bonus: 6, attackType: 'melee' },
              range: { reach: 5, units: 'ft' },
              damage: { parts: [{ formula: '1d6 + 3', type: 'piercing' }] },
            },
          ],
          conditions: [],
        },
      ],
      portrait: {
        lookup: { folder: 'moulinette/cos-tokens', minScore: 0.5 },
        convention: 'auto',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an intent with malformed AC', () => {
    expect(
      ActorIntentSchema.safeParse({
        name: 'X',
        ac: { value: 'fifteen' as unknown as number },
      }).success,
    ).toBe(false);
  });

  it('rejects an intent with an invalid size', () => {
    expect(
      ActorIntentSchema.safeParse({
        name: 'X',
        size: 'Colossal' as unknown as 'Huge',
      }).success,
    ).toBe(false);
  });

  it('rejects an intent with negative HP', () => {
    expect(
      ActorIntentSchema.safeParse({
        name: 'X',
        hp: { max: -5 },
      }).success,
    ).toBe(false);
  });
});

// Phase 12.1.2 fix (2026-05-02) — actorIntentMask reports which fundamentals
// the caller actually supplied so the create-actor pipeline can skip writing
// adapter-defaulted values over a spawned compendium base. Bug surfaced on
// D-00-01 St. Andral's NPCs: Mode E with `actor_intent: { name, base }` only
// produced HP 1 / AC 10 / abilities 10 actors because the synthesized sb's
// defaults flowed straight through buildCoreNumericsChunk.
describe('Phase 12.1.2 fix — actorIntentMask', () => {
  it('returns all-false for a name-only intent (the bug case)', () => {
    const mask = actorIntentMask({ name: 'Test' });
    expect(mask).toEqual({ hp: false, ac: false, speed: false, abilities: false });
  });

  it('returns all-false when only base + name supplied (D-00-01 bug case)', () => {
    const mask = actorIntentMask({
      name: 'Father Lucian Petrovich',
      base: { packId: 'world.ddb-curse-of-strahd-ddb-monsters', itemId: 'ddbPriest16985II' },
    });
    expect(mask).toEqual({ hp: false, ac: false, speed: false, abilities: false });
  });

  it('flips bits true for each block the intent supplies', () => {
    const mask = actorIntentMask({
      name: 'Vampire Spawn',
      ac: { value: 15 },
      hp: { max: 82 },
      speed: { walk: 30 },
      abilities: { str: 16, dex: 16, con: 16, int: 11, wis: 10, cha: 12 },
    });
    expect(mask).toEqual({ hp: true, ac: true, speed: true, abilities: true });
  });

  it('only marks speed true when at least one mode is set (empty speed object stays false)', () => {
    expect(actorIntentMask({ name: 'X', speed: {} }).speed).toBe(false);
    expect(actorIntentMask({ name: 'X', speed: { walk: 30 } }).speed).toBe(true);
    expect(actorIntentMask({ name: 'X', speed: { fly: 60 } }).speed).toBe(true);
    expect(actorIntentMask({ name: 'X', speed: { swim: 40 } }).speed).toBe(true);
    expect(actorIntentMask({ name: 'X', speed: { climb: 20 } }).speed).toBe(true);
    expect(actorIntentMask({ name: 'X', speed: { burrow: 10 } }).speed).toBe(true);
  });

  it('treats hp without max as unset (only formula does not signal a real HP override)', () => {
    expect(actorIntentMask({ name: 'X', hp: {} as any }).hp).toBe(false);
    expect(actorIntentMask({ name: 'X', hp: { max: 1 } }).hp).toBe(true);
  });

  it('treats ac without value as unset (note alone does not signal a real AC override)', () => {
    expect(actorIntentMask({ name: 'X', ac: { note: 'natural armor' } as any }).ac).toBe(false);
    expect(actorIntentMask({ name: 'X', ac: { value: 12 } }).ac).toBe(true);
  });
});
