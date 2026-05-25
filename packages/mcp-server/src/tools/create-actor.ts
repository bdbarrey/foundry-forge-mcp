import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';
import { parseReloadedStatblock, ReloadedStatblock } from '../parsers/reloaded-statblock.js';
import { ParsedAction, parseActionDescription } from '../parsers/action-description.js';
import { parseReloadedProseSpec, ReloadedProseSpec, FeatureOverride } from '../parsers/reloaded-prose.js';
import { resolveFeatIcon } from './feat-icons.js';
import {
  writeScratchItem,
  writeActivityUpdate,
  writeConditionEffect,
  writeTrait,
} from '../intent/intent-writer.js';
import { parsedActionToIntent } from '../intent/parsed-to-intent.js';
import type {
  ActionIntent,
  ActorIntent,
  ConditionIntent,
  TraitIntent,
} from '../intent/activity-intent.js';
import {
  ActionIntentSchema,
  ActorIntentSchema,
  TraitIntentSchema,
} from '../intent/intent-schema.js';
import { actorIntentToReloadedStatblock, actorIntentMask, type ActorIntentMask } from '../intent/actor-intent-adapter.js';
import { ForgeAssetsClient, ForgeAssetEntry } from '../forge-assets-client.js';
import {
  CONFIDENCE_FLOOR,
  CandidateBasic,
  CandidateFull,
  normalizeCreatureType,
  normalizeSize,
  passesHardFilters,
  preScore,
  scoreCandidate,
} from './base-monster-scorer.js';
import {
  ACTION_CONFIDENCE_FLOOR,
  ActionCandidateBasic,
  ActionCandidateFull,
  actionNameVariants,
  passesHardFilters as passesActionHardFilters,
  scoreActionCandidate,
} from './base-action-scorer.js';

export interface CreateActorToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
  forgeAssetsClient?: ForgeAssetsClient | null;
}

interface CompendiumBase {
  packId: string;
  itemId: string;
}

/** Default folder for Phase 5 token lookups. Beneos battlemaps CoS pack. */
const DEFAULT_BENEOS_TOKEN_FOLDER =
  'moulinette/adventures/beneos-battlemaps-universe/beneos_assets/beneos_battlemaps/map_assets/tokens/cos_tokens';

/** Minimum fuzzy-match score to auto-apply a Forge token without confirmation. */
const PORTRAIT_MATCH_FLOOR = 0.5;

export class CreateActorTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;
  private forgeAssetsClient: ForgeAssetsClient | null;

  constructor({ foundryClient, logger, forgeAssetsClient }: CreateActorToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'CreateActorTools' });
    this.errorHandler = new ErrorHandler(this.logger);
    this.forgeAssetsClient = forgeAssetsClient ?? null;
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-actor',
        description:
          'Build a Foundry actor from a CoS Reloaded entry. Five input shapes:\n\nA. Statblock div — Reloaded provides a full `<div class="statblock">` block. Tool spawns from a matched compendium base and overrides every field Reloaded specifies (HP, AC, abilities, skills, traits, actions with attack/save/damage activities, etc.).\n\nB. Prose-only — Reloaded says e.g. "retains the statistics of a **priest**" + "her ***Divine Eminence*** feature now reads as follows:". Tool spawns from the prose-referenced base and rewrites only the named feature descriptions.\n\nC. Pure passthrough — no Reloaded source, just `compendium_base`. Spawn the compendium entry as-is, optionally apply portrait. For NPCs whose Reloaded entry is just a reference (e.g. Rictavio in DDB pack with no modifications).\n\nD. Intent override (Phase 12.1.0/12.1.1) — alongside Mode A, pass `actions_intent: ActionIntent[]` and/or `traits_intent: TraitIntent[]` to fully replace the parser-derived actions / registry-derived traits for those whose name matches by entry. Use actions_intent when Reloaded prose is novel / multi-condition / shaped in a way the regex parser will misread (e.g. Thunderstone with prone + deafened, custom AOE shapes, save-or-half-damage chains the parser misses). Use traits_intent when a trait needs a Midi/DAE effect the TRAIT_TEMPLATES registry doesn\'t cover — registry now ships Pack Tactics, Sunlight Sensitivity, Sunlight Hypersensitivity (with 20 radiant OverTime), Regeneration (parses heal amount + max-HP condition), and Magic Resistance. For traits outside the registry (Spider Climb-with-effect, Aura of Dread, etc.) emit kind="custom" with a CustomTraitEffect spec. Each entry replaces the action/trait of the same name (case-insensitive after stripping any "(1/Day)" / "(Recharge X-Y)" suffix). Actions/traits whose name doesn\'t appear fall back to the parser/registry as before. Statblock-level fields (HP/AC/abilities/skills) still come from the Reloaded source — Mode D only controls action and trait items.\n\nE. Full ActorIntent (Phase 12.1.2) — pass `actor_intent: ActorIntent` to bypass the regex parser entirely. Statblock fundamentals (HP/AC/abilities/skills/senses/defenses/languages/CR) come from the intent; traits and actions go through the same Mode D override paths automatically (actor_intent.traits → traits_intent, actor_intent.{actions,bonusActions,reactions,legendaryActions,lairActions} → actions_intent). Use Mode E when (a) the creature has no Reloaded markdown source, (b) the prose is non-canonical, or (c) you want full structured control. Provide actor_intent.base for the compendium spawn target; the existing search-by-name fallback also applies if base is omitted.\n\nActionIntent shape (Phase 12.0 schema; full TS types in src/intent/activity-intent.ts):\n  { name: string,                       // matches Reloaded action name\n    description: string,                 // prose for system.description.value\n    activities: ActivityIntent[],        // 1-2 entries: attack, save, or both chained\n    conditions: ConditionIntent[],       // 0-N rider effects (prone, restrained, etc.)\n    usage?: { count, period } | { recharge: [n,m] },\n    versatile?: { formula, type },       // alt damage for two-handed weapons\n    midiProperties?: { saveDamage: "halfdam"|"fulldam"|"nodam" } }\n  ActivityIntent: { intentId: string, kind: "attack"|"save"|"damage", name: string,\n    range?: { value?, long?, reach?, units: "ft" },\n    target?: { template?: { shape: "circle"|"cone"|"line"|"cube"|"sphere"|"cylinder", size, width? },\n               affects?: { type: "creature"|"enemy"|"ally"|..., count?, choice? } },\n    attack?: { bonus: number, attackType?: "melee"|"ranged" },\n    save?: { ability: "str"|"dex"|..., dc: number, onSuccess?: "half" },\n    damage?: { parts: [{formula, type}], includeBase?: boolean, onSave?: "half"|"none"|"full" },\n    triggers?: { activityRef: <other intentId>, targets: "hit"|"all" },  // attack→save chain\n    effects?: [{ conditionRef: number, onSave?: boolean }] }            // index into conditions[]\n  ConditionIntent: { type: "blinded"|"charmed"|...|"unconscious",\n    duration?: { rounds?, seconds?, specialDuration?: "turnEnd"|"turnStart"|... },\n    repeatSave?: { period: "turnEnd"|"turnStart", ability, dc } }      // INDEFINITE; save-to-break\n\nFor Bite-style (attack triggers save after hit), emit TWO activities: an attack with triggers={activityRef:"save", targets:"hit"} pointing at the save\'s intentId, and the save with effects=[{conditionRef:0}] linking to conditions[0]. Multi-condition saves (Thunderstone prone+deafened): conditions=[{type:"prone"},{type:"deafened"}] + save activity.effects=[{conditionRef:0},{conditionRef:1}].\n\nProvide EITHER reloaded_source/file_path+creature_name (modes A/B), OR compendium_base alone (mode C). Optional `portrait` arg applies in all modes. `actions_intent` is additive on top of A/B.',
        inputSchema: {
          type: 'object',
          properties: {
            reloaded_source: {
              type: 'string',
              description: 'Markdown containing exactly one <div class="statblock"> block. Use this OR file_path+creature_name.',
            },
            file_path: {
              type: 'string',
              description: 'Absolute path to a Reloaded markdown file (e.g. the Bestiary or a chapter file). Requires creature_name.',
            },
            creature_name: {
              type: 'string',
              description: 'Heading text under which the statblock lives in file_path (e.g. "Wight Commander" → matches `### Wight Commander`).',
            },
            compendium_base: {
              type: 'object',
              description: 'Optional explicit compendium source. If omitted, the tool auto-searches by parsed creature name and falls back to common base-name stems (e.g. "Wight Commander" → "Wight").',
              properties: {
                packId: { type: 'string', description: 'Compendium pack ID (e.g. "dnd5e.monsters").' },
                itemId: { type: 'string', description: 'Entry ID within the pack.' },
              },
              required: ['packId', 'itemId'],
            },
            portrait: {
              type: 'object',
              description: 'Phase 5: optionally apply a portrait + token image after the actor is built. Two modes: explicit `path` (applies as-is) or `lookup` (browses a Forge folder, fuzzy-matches the creature name, detects portrait/token pair conventions). Requires FORGE_ASSETS_API_KEY in backend env for `lookup` mode.',
              properties: {
                path: {
                  type: 'string',
                  description: 'Explicit Foundry-relative path or full URL (e.g. "moulinette/.../cos_tokens/Volenta.webp"). Applied as-is.',
                },
                lookup: {
                  type: 'object',
                  description: 'Fuzzy-match a portrait in a Forge folder by creature name. Recursively walks subdirs (My Avatars, NPCs, Strahd\'s Minions etc. live in subfolders) and detects pair conventions (Beneos `_token` suffix, Tokenizer `.Avatar`/`.Token` suffix, sibling Avatars/Tokens or Portrait/Token folders).',
                  properties: {
                    folder: {
                      type: 'string',
                      description: 'Foundry-relative Forge folder to browse. Defaults to the Beneos CoS tokens path.',
                    },
                    minScore: {
                      type: 'number',
                      description: 'Minimum fuzzy-match score [0..1] to auto-apply (default 0.5). Below this, the resolver returns top candidates without applying so the caller can confirm.',
                      minimum: 0, maximum: 1,
                    },
                    names: {
                      type: 'array',
                      description: 'Override the candidate names for the fuzzy match. By default the resolver uses variants of the Reloaded creature name (full / pre-comma / role-stripped). Pass alternate spellings here when needed (e.g. ["valenta", "valenta popofsky"] for Beneos\'s Volenta).',
                      items: { type: 'string' },
                    },
                    recursive: {
                      type: 'boolean',
                      description: 'Walk subdirs (default true). Required for `My Avatars` whose actual files live in nested folders. Bounded at depth 3.',
                    },
                  },
                },
                convention: {
                  type: 'string',
                  enum: ['auto', 'single', 'tokenizer'],
                  description: 'How to apply the resolved image to the actor. `auto` (default): detect pair convention; if pair found, set portrait + token from the right sibling files; otherwise behave like `single`. `single`: same URL for `img` + `prototypeToken.texture.src`. `tokenizer`: set only `img` and leave `prototypeToken.texture.src` alone — the Tokenizer module on the client will auto-generate a token from the portrait when actor.img changes.',
                },
                applyToToken: {
                  type: 'boolean',
                  description: 'Also set prototypeToken.texture.src (default true; ignored under convention=tokenizer).',
                },
              },
            },
            prune_base_items: {
              type: 'boolean',
              description: 'Phase 3b extension (Mode A only). When true (default since 2026-05-17 per Arc H AAR), after the build runs, walk the actor\'s feat AND weapon items and remove compendium-base entries that have no name-token overlap with any Reloaded trait or action. In dnd5e 5.x NPC attacks (Bite, Claws, Longsword, Hail of Daggers) are `type=weapon` items, so weapon-pruning is required to drop SRD vampire\'s Bite/Claws on a Volenta build. Spells/equipment/classes/races/backgrounds/containers/loot stay safe. ALWAYS_KEEP list preserves common monster traits (Multiattack, Spellcasting, Legendary Resistance, Sunlight Sensitivity, etc.), token-overlap with Reloaded names preserves matched items (e.g. our copy-patched "Hail of Daggers" overlaps "daggers" with Reloaded\'s action of the same name). Hard cap of 5 deletions per run. Pass `prune_base_items: false` ONLY for Mode C passthrough builds where Reloaded prose paraphrases base features verbatim (Arc F Ernst Larnak case — Reloaded said "uses Spy stats" instead of quoting each feature name, so pruning over-deleted). Off-by-default produced Specter base contamination on both Arc H Leo Dilisnya forms. Result is reported as `prunedItems` and `prunedCandidatesOverCap`.',
            },
            actions_intent: {
              type: 'array',
              description: 'Phase 12.1 — Mode D intent override. Each entry is an ActionIntent (see schema in tool description). Entries replace the parser-derived shape for actions whose name (case-insensitive, usage-suffix-stripped) matches `intent.name`. Use when Reloaded prose is novel / multi-condition / shaped in a way the regex parser will misread. Actions not listed here fall back to parser as before.',
              items: { type: 'object' },
            },
            traits_intent: {
              type: 'array',
              description: 'Phase 12.1.1 — trait override. Each entry is a TraitIntent: { kind: "pack-tactics"|"sunlight-sensitivity"|"sunlight-hypersensitivity"|"regeneration"|"magic-resistance"|"description-only"|"custom", name: string, description: string, custom?: CustomTraitEffect }. Entries replace the registry/description-only shape for traits whose name matches (case-insensitive). For unknown traits with mechanical effects (Spider Climb-with-effect, Aura of Dread, etc.) use kind="custom" with a CustomTraitEffect spec: { effectName?, img?, statuses?, transfer?, disabled?, changes: [{key, value, mode?, priority?}], duration?, flags? }. Built-in kinds bake the canonical Midi shape automatically: "regeneration" parses the heal amount from description and includes a skip-at-max-HP condition; "sunlight-hypersensitivity" includes the 20-radiant-damage OverTime tick (vampires) on top of the disadvantage flags; "magic-resistance" emits flags.midi-qol.magicResistance.all. Traits not listed here fall through to TRAIT_TEMPLATES registry → description-only feat. Common Midi-QOL change keys: "flags.midi-qol.advantage.attack.all", "flags.midi-qol.disadvantage.ability.save.all", "flags.midi-qol.OverTime.<key>", "system.attributes.movement.{walk|fly|climb|swim}", "system.traits.di.value" (damage immunity), etc.',
              items: { type: 'object' },
            },
            actor_intent: {
              type: 'object',
              description: 'Phase 12.1.2 — Mode E: full ActorIntent that bypasses the regex parser entirely. Use this when (a) the creature\'s prose doesn\'t fit Reloaded\'s statblock format, (b) you have all the structured data to build the actor without parsing markdown, or (c) you want maximum control over every field. Shape: { name, base?: {packId, itemId}, size?: "Tiny|Small|Medium|Large|Huge|Gargantuan", type?, subtype?, alignment?, ac?: {value, note?}, hp?: {max, formula?}, speed?: {walk?, swim?, fly?, climb?, burrow?, hover?}, abilities?: {str,dex,con,int,wis,cha}, saves?: {<ability>: bonus}, skills?: {<skill>: bonus}, senses?: {darkvision?, blindsight?, truesight?, tremorsense?, passivePerception?}, damageResistances?: string[], damageImmunities?: string[], damageVulnerabilities?: string[], conditionImmunities?: ConditionType[], languages?: string[], cr?: number|string, proficiencyBonus?, traits?: TraitIntent[], actions?: ActionIntent[], bonusActions?: ActionIntent[], reactions?: ActionIntent[], legendaryActions?: ActionIntent[], lairActions?: ActionIntent[], portrait?: PortraitIntent }. actor_intent.base populates compendium_base; actor_intent.actions/traits/portrait pass through to actions_intent/traits_intent/portrait when those aren\'t already set at the top level. Pass actor_intent ALONE (no reloaded_source/file_path) for Mode E; otherwise actor_intent extends Mode A.',
            },
          },
        },
      },
      {
        name: 'create-actors',
        description:
          'Phase 12.1.3 — batch create. Takes an array of create-actor inputs and applies them sequentially with per-actor failure isolation. Use when you need to populate a scene end-to-end ("create all the actors for scene X"): emit one entry per creature, pass them all in `actors`, and the tool returns a per-actor result (success + actorId, or failure + error). Failures isolate — a malformed entry doesn\'t halt the batch. Each entry follows the same shape as create-actor input — Mode A (reloaded_source / file_path+creature_name), Mode B (prose), Mode C (compendium_base passthrough), Mode D (Mode A + actions_intent / traits_intent), Mode E (actor_intent), all supported per entry. Sequential execution to avoid Foundry race conditions on concurrent createEmbeddedDocuments. Returns { total, succeeded, failed, results: [{name, success, actorId?, error?, detail?}] }.',
        inputSchema: {
          type: 'object',
          required: ['actors'],
          properties: {
            actors: {
              type: 'array',
              description: 'Array of create-actor inputs. Each entry is the same shape as the create-actor tool\'s input. You can mix modes per entry — e.g. emit actor_intent for homebrew creatures, reloaded_source for known Reloaded NPCs, compendium_base passthrough for actors with no Reloaded modifications.',
              items: { type: 'object' },
              minItems: 1,
            },
          },
        },
      },
      {
        name: 'infer-base-monster',
        description:
          'Pre-step for create-actor on Reloaded creatures: parse a Reloaded statblock and return a ranked list of candidate compendium monsters to use as the base for create-actor\'s hybrid path. Scores candidates by CR/HP/AC proximity, ability-score cosine, size, and TRAIT/ACTION NAME OVERLAP — which is the strongest fingerprint (e.g. a CR-5 undead sharing Regeneration + Spider Climb + Sunlight Hypersensitivity is almost certainly built on Vampire Spawn, not a generic undead). Typical workflow: user says "create <Name> actor" → call infer-base-monster first → pass topPick.packId/itemId as create-actor\'s compendium_base. Confidence tier "high" means proceed silently; "low" means no candidate cleared the floor (0.55) and you should ask the user or consider scratch-build.',
        inputSchema: {
          type: 'object',
          properties: {
            reloaded_source: {
              type: 'string',
              description: 'Markdown containing exactly one <div class="statblock"> block. Use this OR file_path+creature_name.',
            },
            file_path: {
              type: 'string',
              description: 'Absolute path to a Reloaded markdown file. Requires creature_name.',
            },
            creature_name: {
              type: 'string',
              description: 'Heading text under which the statblock lives in file_path (e.g. "Volenta, First Form").',
            },
            top_n: {
              type: 'number',
              description: 'Number of candidates to return (default 5, max 10).',
              minimum: 1,
              maximum: 10,
            },
          },
        },
      },
      {
        name: 'infer-base-action',
        description:
          'Pre-step for create-actor\'s Phase 3b action-build pass: given a Reloaded action (name + description OR pre-parsed ParsedAction), return ranked compendium Item candidates to use as the base for copy-patching. Strongly weighted toward exact / stem name match (Volenta\'s "Thunderstone" → SRD Thunderstone; "Hail of Daggers" → Dagger) with structural tie-breakers (damage type overlap, attack-vs-save category). Call this to debug picks; create-actor invokes this logic internally for every actionsSkippedNoItem entry and copy-patches high-confidence matches automatically.',
        inputSchema: {
          type: 'object',
          properties: {
            action_name: {
              type: 'string',
              description: 'Reloaded action name as printed (e.g. "Thunderstone (1/day)").',
            },
            action_description: {
              type: 'string',
              description: 'Plain-text description of the action. Used to derive ParsedAction if not provided directly.',
            },
            top_n: {
              type: 'number',
              description: 'Number of candidates to return (default 3, max 10).',
              minimum: 1,
              maximum: 10,
            },
          },
          required: ['action_name'],
        },
      },
    ];
  }

  async handleCreateActor(args: any): Promise<any> {
    const schema = z.object({
      reloaded_source: z.string().optional(),
      file_path: z.string().optional(),
      creature_name: z.string().optional(),
      compendium_base: z.object({
        packId: z.string().min(1),
        itemId: z.string().min(1),
      }).optional(),
      // Optional name override for the spawned actor when no Reloaded source
      // is given (Mode C: pure passthrough). Defaults to compendium entry name.
      actor_name: z.string().optional(),
      portrait: z.object({
        path: z.string().optional(),
        lookup: z.object({
          folder: z.string().optional(),
          minScore: z.number().min(0).max(1).optional(),
          names: z.array(z.string()).optional(),
          recursive: z.boolean().optional(),
        }).optional(),
        convention: z.enum(['auto', 'single', 'tokenizer']).optional(),
        applyToToken: z.boolean().optional(),
      }).optional(),
      // Phase 3b extension: opt-in pruning of compendium-base feats absent
      // from the Reloaded source (e.g. drop SRD Vampire's Bite/Claws when
      // Reloaded only specifies Hail of Daggers/Dagger). Default false —
      // pruning is conservative (hard cap of 5, type=feat only, ALWAYS_KEEP
      // list for common monster traits) but still fallible on heavy renames.
      prune_base_items: z.boolean().optional(),
      // Phase 12.1 — Mode D intent override. Array of ActionIntent objects;
      // each entry replaces the parser-derived shape for the action whose
      // name matches (case-insensitive, after stripping any "(1/Day)" /
      // "(Recharge X-Y)" suffix). Validation runs per-entry via
      // ActionIntentSchema, with cross-field invariants (effects[].conditionRef
      // in range, triggers.activityRef matches an activity intentId).
      actions_intent: z.array(ActionIntentSchema).optional(),
      // Phase 12.1.1 — Mode D extension: trait override. Array of TraitIntent
      // objects; each entry replaces the registry/description-only shape for
      // the trait whose name matches (case-insensitive). For known canonical
      // traits the registry already handles correctly (Pack Tactics, Sunlight
      // Sensitivity), don't pass intent unless you want to override. For
      // traits the registry doesn't cover (Magic Resistance, Regeneration,
      // Spider Climb-with-effect), use kind='custom' with a CustomTraitEffect.
      traits_intent: z.array(TraitIntentSchema).optional(),
      // Phase 12.1.2 — Mode E: full ActorIntent. Bypasses the regex parser
      // entirely (statblock fields, traits, actions all from intent). When
      // provided, the synthesized ReloadedStatblock shape feeds the existing
      // Mode A pipeline (compendium spawn → chunked overrides → trait/action
      // add). actor_intent.base populates compendium_base; actor_intent.actions
      // → actions_intent; actor_intent.traits → traits_intent; actor_intent.portrait
      // → portrait — except where the caller already set those at the top level
      // (top-level fields win, so partial overrides are possible).
      actor_intent: ActorIntentSchema.optional(),
      // Arc I AAR 2026-05-19 / 2026-05-22 follow-up: duplicate-name pre-check.
      // create-actor pre-2026-05-22 silently spawned a second actor when one
      // with the same name already existed in `Foundry MCP Creatures`, leaving
      // strays from earlier failed builds undetected (Arc I had a
      // TMa7ZixWbZsFb8z1 Baba Lysaga Witch Mother HP=120 stub orphaned for
      // hours). Default behavior now refuses with a clear error naming the
      // existing actor id so the user can delete the stray manually and retry.
      // No `replace: true` shortcut today — the module-side deleteActor query
      // doesn't exist; manual cleanup keeps the human-confirmation step that
      // matches the standing "user does this manually" pattern in
      // workflow-arc-generation.md (Phase B step 5 stray-handling note).
      // When module-side delete ships, a `replace` flag can be added here
      // for one-shot overwrite — TODO.
    }).refine(
      // Valid input shapes:
      //   A. reloaded_source (or file_path+creature_name) — has statblock or prose
      //   B. compendium_base alone — pure passthrough (Rictavio case)
      //   E. actor_intent — full intent, no markdown parsing
      d => !!d.reloaded_source
        || !!(d.file_path && d.creature_name)
        || !!d.compendium_base
        || !!d.actor_intent,
      { message: 'Provide reloaded_source, file_path+creature_name, compendium_base, or actor_intent' },
    );
    const input = schema.parse(args);

    this.logger.info('create-actor invoked', {
      hasSource: !!input.reloaded_source,
      filePath: input.file_path,
      creatureName: input.creature_name,
      explicitBase: !!input.compendium_base,
    });

    try {
      // ROUTER: five input shapes, four pipelines.
      //
      //   A. reloaded_source has a `<div class="statblock">`  → existing rich
      //      Phase 0-3 build (numeric overrides, traits, actions, etc.)
      //   B. reloaded_source has prose only (no statblock div) → spawn from
      //      `baseHint` + apply feature_overrides + portrait
      //   C. no reloaded_source, compendium_base alone        → pure spawn +
      //      portrait (Rictavio case)
      //   D. actions_intent / traits_intent extends A/B/C        → name-keyed
      //      override of parser/registry shapes (Phase 12.1.0/.1.1)
      //   E. actor_intent fully replaces A/B's parsing            → synthesize
      //      sb from intent, run through Mode A pipeline (Phase 12.1.2)
      //
      // Phase 12.1.2 — Mode E: when actor_intent is provided, synthesize a
      // ReloadedStatblock-shape from it and pull through actions_intent /
      // traits_intent / compendium_base / portrait so the existing Mode A
      // pipeline runs unchanged. Top-level inputs win when both are set.
      let sbFromIntent: ReloadedStatblock | null = null;
      // Phase 12.1.2 fix (2026-05-02): track which fundamentals the intent
      // actually supplied so the adapter's defaults don't clobber the spawned
      // compendium base. Mode A leaves this null (chunk-builders write
      // everything); Mode E sets it from actorIntentMask(actor_intent).
      let intentMask: ActorIntentMask | null = null;
      if (input.actor_intent) {
        const actorIntent = input.actor_intent as ActorIntent;
        sbFromIntent = actorIntentToReloadedStatblock(actorIntent);
        intentMask = actorIntentMask(actorIntent);
        if (actorIntent.base && !input.compendium_base) {
          input.compendium_base = actorIntent.base;
        }
        if (actorIntent.traits && !input.traits_intent) {
          input.traits_intent = actorIntent.traits;
        }
        // Combine all action categories (actions / bonusActions / reactions /
        // legendaryActions / lairActions) into a single actions_intent array.
        // The synthetic sb keeps them in their original sb.<category> arrays;
        // the action loop iterates allReloadedActions = [...sb.actions,
        // ...sb.bonusActions, ...] and matches each by name to actions_intent.
        // Names must be unique across categories (a real-world constraint
        // anyway, since a creature can't have an action and a reaction with
        // the same name).
        if (!input.actions_intent) {
          const all = [
            ...(actorIntent.actions ?? []),
            ...(actorIntent.bonusActions ?? []),
            ...(actorIntent.reactions ?? []),
            ...(actorIntent.legendaryActions ?? []),
            ...(actorIntent.lairActions ?? []),
          ];
          if (all.length > 0) input.actions_intent = all;
        }
        if (actorIntent.portrait && !input.portrait) {
          input.portrait = actorIntent.portrait;
        }
        this.logger.info('Mode E: actor_intent dispatch', {
          name: actorIntent.name,
          actions: (actorIntent.actions ?? []).length,
          traits: (actorIntent.traits ?? []).length,
          hasBase: !!actorIntent.base,
        });
      }

      // Resolve source first if we have one. If not and we have compendium_base,
      // run the passthrough pipeline. Mode E supplies sbFromIntent and skips
      // the markdown source step entirely.
      const hasSource = !!input.reloaded_source || !!(input.file_path && input.creature_name);
      if (!hasSource && !sbFromIntent) {
        // Mode C — passthrough.
        return await this.runPassthroughBuild(input);
      }

      // 1. Get markdown source (Modes A + B). Mode E already has sbFromIntent.
      let sbParsed: ReloadedStatblock | null = sbFromIntent;
      let proseSpec: ReloadedProseSpec | null = null;
      if (!sbParsed) {
        const markdown = await this.resolveSource(input);
        // 2. Parse — try statblock first; fall back to prose if no div found.
        try {
          sbParsed = parseReloadedStatblock(markdown);
        } catch (err) {
          // No statblock div — try prose.
          proseSpec = parseReloadedProseSpec(markdown);
          if (!proseSpec) {
            throw new Error(
              'Reloaded source has no <div class="statblock"> and no recognizable prose patterns ' +
              '("retains the statistics of a X" / "treat as **X**" / feature override bullets). ' +
              'Pass a full Reloaded statblock OR use compendium_base for pure passthrough.',
            );
          }
        }
      }

      // Mode B — prose dispatch.
      if (proseSpec) {
        return await this.runProseBuild(proseSpec, input);
      }

      // Mode A or E — full statblock build (existing Phases 0-3).
      const sb = sbParsed!;
      this.logger.debug('Parsed statblock', { name: sb.name, cr: sb.challenge });

      // 3. Find compendium base
      const base = input.compendium_base ?? await this.searchForCompendiumBase(sb.name);
      if (!base) {
        throw new Error(
          `No compendium base found for "${sb.name}". Pass compendium_base explicitly with {packId, itemId}, ` +
          `or use search-compendium to find a suitable base. Phase 6 (homebrew scratch-build) is not yet implemented.`,
        );
      }
      this.logger.info('Using compendium base', base);

      // 4. Spawn via compendium
      //    Duplicate-actor pre-check (Arc I AAR shipped 2026-05-22).
      //    Mode A spawns directly via createActorFromCompendium rather than
      //    through spawnFromCompendium, so the duplicate check has to be
      //    explicit here. Refuses with the existing actor id named so the
      //    user can decide whether to delete the stray or treat the existing
      //    one as the build target.
      await this.ensureNoDuplicateInStaging(sb.name);
      const spawn: any = await this.foundryClient.query('foundry-forge-mcp.createActorFromCompendium', {
        packId: base.packId,
        itemId: base.itemId,
        customNames: [sb.name],
        quantity: 1,
        addToScene: false,
      });
      if (!spawn?.success || !spawn.actors?.length) {
        throw new Error(
          `Compendium spawn failed for pack=${base.packId} item=${base.itemId}: ${spawn?.errors?.join('; ') ?? 'unknown error'}`,
        );
      }
      const newActor = spawn.actors[0] as { id: string; name: string };
      this.logger.info('Actor spawned from compendium', { id: newActor.id, name: newActor.name });

      // 5. Pull the newly-spawned actor's items so we can diff against
      //    Reloaded (decide which traits to add vs. let stand).
      //    Query by ID (not name) so pre-existing same-named actors don't
      //    pollute existingItemNames — without this, a second build of
      //    "Volenta, First Form" reads the OLD Volenta's items and wrongly
      //    marks Reloaded traits as already-present + routes every action to
      //    actionsSkippedNoActivity with stale item ids.
      const actorFull: any = await this.foundryClient.query('foundry-forge-mcp.getCharacterInfo', {
        characterName: newActor.id,
      });
      const existingItemNames = new Set(
        (actorFull?.items ?? []).map((i: any) => String(i.name ?? '').toLowerCase()),
      );

      // 6. Apply field overrides in small chunks so that a failure in one
      //    category (e.g. dnd5e rejects the prof-bonus override) doesn't
      //    prevent the others from landing.
      const updateResults = await this.applyOverridesChunked(newActor.id, sb, input, intentMask);
      // Concatenate successfully-written field keys for the response.
      const successfulUpdateKeys = updateResults.filter(r => r.ok).flatMap(r => r.fields);
      const failedUpdateChunks = updateResults.filter(r => !r.ok).map(r => ({ chunk: r.label, error: r.error }));

      // 6b. Seed system.spells.spellN from the Spellcasting feat's prose so
      //     slot-aware HUDs (Argon Combat HUD, Tidy 5e, etc.) render the
      //     spell rows. Compendium NPC bases ship a Spellcasting feat with
      //     "Nth level (X slots): ..." in the description but never populate
      //     the actor's slot fields — Foundry's NPC sheet inspects the prose
      //     directly, but third-party HUDs read system.spells.spellN.max.
      //     Without this step, prepared spells exist on the actor but level
      //     rows render empty in HUDs. Idempotent — re-running on an actor
      //     whose slots already match writes the same values.
      const spellSlotKeys = await this.seedSpellSlotsFromSpellcastingFeat(
        newActor.id,
        actorFull?.items ?? [],
      );
      if (spellSlotKeys.length > 0) {
        successfulUpdateKeys.push(...spellSlotKeys);
      }

      // 7. Add Reloaded-only traits (no attack/damage/save — pure narrative).
      //    Traits whose names already exist on the actor (e.g. "Sunlight
      //    Sensitivity" inherited from the compendium Wight) are left alone;
      //    updating divergent descriptions ships in Phase 3a-C.
      //
      // Phase 12.1.1 — Mode D extension: trait override. When the caller
      // (orchestrating Claude session) supplies traits_intent, each entry
      // replaces the registry/description-only shape for traits matched by
      // name (case-insensitive). Cast at the Zod boundary like actions_intent.
      const traitIntentByName = new Map<string, TraitIntent>();
      for (const intent of (input.traits_intent ?? []) as TraitIntent[]) {
        traitIntentByName.set(intent.name.toLowerCase(), intent);
      }
      const traitsToAdd = await Promise.all(
        sb.traits
          .filter(t => !existingItemNames.has(t.name.toLowerCase()))
          .map(async t => {
            const overrideTraitIntent = traitIntentByName.get(t.name.toLowerCase());
            // Description override: prefer intent.description (caller's
            // canonical prose) when intent-mode; fall back to Reloaded prose.
            const description = overrideTraitIntent?.description ?? t.description;
            const baseDoc: Record<string, any> = {
              name: t.name,
              type: 'feat',
              // Phase 9: pick a themed icon up front so the sheet doesn't show
              // a generic star next to every Reloaded-only trait. Resolver is
              // async because it HEAD-probes Forge bazaar URLs to weed out
              // broken paths and roll forward to verified fallbacks.
              img: await resolveFeatIcon(t.name, t.parsed),
              system: {
                description: { value: `<p>${escapeHtml(description)}</p>` },
                source: { book: 'CoS Reloaded' },
                type: { value: 'monster' },
              },
            };
            // Effect-block source priority:
            //   1. traits_intent (Mode D override) — caller emits TraitIntent;
            //      writeTrait handles 'pack-tactics' / 'sunlight-sensitivity'
            //      via the canonical writer branches, 'custom' via the
            //      caller-supplied CustomTraitEffect, 'description-only' as no-op.
            //   2. TRAIT_TEMPLATES registry — name-keyed lookup for canonical
            //      traits (Pack Tactics, Sunlight Sensitivity etc.) when no
            //      intent override is provided.
            //   3. Otherwise plain feat (Awakened Bloodlust, Fast Grappler,
            //      Volenta-unique inventions).
            let additions: Record<string, any> = {};
            if (overrideTraitIntent) {
              additions = writeTrait(overrideTraitIntent);
            } else {
              const template = resolveTraitTemplate(t.name);
              if (template) {
                additions = template.build(t.name, t.description);
              }
            }
            for (const [key, value] of Object.entries(additions)) {
              if (key === 'system' && baseDoc.system && typeof value === 'object') {
                baseDoc.system = { ...baseDoc.system, ...value };
              } else {
                baseDoc[key] = value;
              }
            }
            return baseDoc;
          }),
      );
      let addedTraitNames: string[] = [];
      let traitAddFailures: Array<{ name: string; error: string }> = [];
      if (traitsToAdd.length > 0) {
        const result = await this.addItemsWithBatchFallback(newActor.id, traitsToAdd);
        addedTraitNames = result.added;
        traitAddFailures = result.failed;
      }

      // 8. Update existing action items' structured combat data to match
      //    Reloaded: attack bonus, damage parts, save DC, reach/range. We
      //    patch the item's primary activity (type='attack' preferred when
      //    Reloaded has an attack bonus; type='save' preferred when Reloaded
      //    has a save; otherwise first activity). Items without activities
      //    (pre-dnd5e-4.x legacy items or pure-narrative feats) are skipped —
      //    their legacy field updates land in a follow-up.
      // Phase 8: Index items by stem (with usage suffix stripped) so a base
      // item named "Tanglefoot" matches a Reloaded action named
      // "Tanglefoot (1/day)" and vice versa. We also keep the full lower-case
      // name lookup as a fallback to preserve exact-match semantics for items
      // whose names happen to contain parens that aren't usage markers.
      const itemsByName = new Map<string, any>();
      const itemsByStem = new Map<string, any>();
      for (const item of actorFull?.items ?? []) {
        const fullName = String(item.name ?? '');
        itemsByName.set(fullName.toLowerCase(), item);
        const itemStem = stripUsageSuffix(fullName).stem.toLowerCase();
        if (itemStem) itemsByStem.set(itemStem, item);
      }
      const allReloadedActions = [
        ...sb.actions, ...sb.bonusActions, ...sb.reactions,
        ...sb.legendaryActions, ...sb.lairActions,
      ];
      // Phase 12.1 — Mode D intent override. Build a name-keyed map of
      // ActionIntents the caller (the orchestrating Claude session) wants
      // to use in place of the parser-derived shape. Match key is the
      // stem-stripped lowercased name so "Tanglefoot (1/Day)" matches a
      // Reloaded action named "Tanglefoot" or vice versa.
      // Cast at the Zod boundary: the schema's inferred type uses `T | undefined`
      // for optional fields (Zod default), which exactOptionalPropertyTypes
      // rejects against ActionIntent's `T?` shape. Runtime shape is identical.
      const intentByName = new Map<string, ActionIntent>();
      for (const intent of (input.actions_intent ?? []) as ActionIntent[]) {
        const key = stripUsageSuffix(intent.name).stem.toLowerCase() || intent.name.toLowerCase();
        intentByName.set(key, intent);
      }
      const itemUpdates: Array<Record<string, any>> = [];
      const actionsSynced: string[] = [];
      const actionsSkippedNoItem: string[] = [];
      const actionsSkippedNoActivity: string[] = [];

      for (const action of allReloadedActions) {
        const actionStem = stripUsageSuffix(action.name).stem.toLowerCase();
        // Prefer exact full-name match (covers items with parens that aren't
        // usage markers); fall back to stem-stripped lookup.
        const item =
          itemsByName.get(action.name.toLowerCase())
          ?? itemsByStem.get(actionStem);
        if (!item) {
          actionsSkippedNoItem.push(action.name);
          continue;
        }
        const activities = item.system?.activities ?? {};
        if (!activities || Object.keys(activities).length === 0) {
          actionsSkippedNoActivity.push(action.name);
          continue;
        }
        // Phase 12.1 lookup: does the caller want intent-mode for this action?
        const overrideIntent = intentByName.get(actionStem) ?? intentByName.get(action.name.toLowerCase());
        // Walk every activity on the item and patch only the fields relevant
        // to that activity's type. One item can have both an `attack` and a
        // `save` activity (e.g. Wight Commander Life Drain) — both need
        // Reloaded's values applied. Intent-mode bypasses the parser-derived
        // shape; parser-mode (no override) goes through buildItemActivityUpdate
        // which itself adapts to ActionIntent under the hood.
        const itemUpdate = overrideIntent
          ? writeActivityUpdate(item.id, activities, overrideIntent)
          : buildItemActivityUpdate(item.id, activities, action.parsed);
        // Description override: prefer the intent's description (the caller's
        // canonical prose) when intent-mode; fall back to Reloaded action.description.
        const description = overrideIntent?.description ?? action.description;
        if (description) {
          itemUpdate['system.description.value'] = `<p>${escapeHtml(description)}</p>`;
        }
        // Phase 8: write `system.uses` (max + recovery) when Reloaded
        // encoded usage in the name parenthetical. Also normalize the
        // existing item's name to the bare stem so the sheet shows
        // "Tanglefoot" with a 1/day counter rather than "Tanglefoot (1/day)"
        // duplicating the usage in two places. Skip the rename if the item
        // already has the bare stem name (avoids a no-op write). Intent-mode
        // takes its uses from intent.usage (caller's authoritative shape).
        const usesPayload = buildUsesPayload(overrideIntent?.usage ?? action.parsed.usage);
        if (usesPayload) {
          itemUpdate['system.uses'] = usesPayload;
        }
        const reloadedStem = stripUsageSuffix(action.name).stem;
        const itemFullName = String(item.name ?? '');
        if (reloadedStem && itemFullName.toLowerCase() !== reloadedStem.toLowerCase()) {
          itemUpdate['name'] = reloadedStem;
        }
        if (Object.keys(itemUpdate).length > 1) {
          itemUpdates.push(itemUpdate);
          actionsSynced.push(action.name);
        }
      }

      // Issue item updates one at a time so a bad single-item payload can't
      // hang the whole orchestrator. Skipped-item names end up in a report
      // field so the caller sees which actions didn't land.
      const actionSyncFailures: Array<{ name: string; error: string }> = [];
      for (let i = 0; i < itemUpdates.length; i++) {
        const iu = itemUpdates[i];
        const actionName = actionsSynced[i];
        try {
          const r: any = await this.foundryClient.query('foundry-forge-mcp.updateActorItems', {
            actorId: newActor.id,
            updates: [iu],
          });
          if (r?.success === false) {
            actionSyncFailures.push({ name: actionName, error: r?.error ?? 'update returned success=false' });
          }
        } catch (err: any) {
          actionSyncFailures.push({ name: actionName, error: err?.message ?? String(err) });
          this.logger.warn(`action sync "${actionName}" failed`, { error: err?.message, itemId: iu._id });
        }
      }

      // 9. Phase 3b: for Reloaded actions that aren't on the compendium base
      //    actor, infer a compendium Item to copy-patch from (e.g. Volenta's
      //    Thunderstone → SRD Thunderstone, Firebomb → Alchemist's Fire).
      //    Falls back to scratch-build feat when no candidate clears the
      //    confidence floor. Runs sequentially (one add-item per action) to
      //    sidestep the addActorItems batch cliff we discovered in 3a-polish.
      const actionsCopyPatched: Array<{ name: string; base: string; score: number }> = [];
      const actionsScratchBuilt: string[] = [];
      const actionsBuildFailures: Array<{ name: string; error: string }> = [];
      // Per copy-patched item: traces every step of the post-create activity-update
      // orchestration so failures surface in the response (manual hot-patches were
      // needed because the in-flight update silently no-op'd). Persistent — leave
      // in place even after Phase 0 closes; cheap data, large debugging payoff.
      const copyPatchDiag: Array<Record<string, any>> = [];

      // Build a quick lookup from action-name to the raw action struct (we need
      // both .name and .parsed + .description for the build).
      const skippedByName = new Map<string, typeof allReloadedActions[number]>();
      for (const a of allReloadedActions) {
        if (actionsSkippedNoItem.includes(a.name)) skippedByName.set(a.name, a);
      }

      for (const name of actionsSkippedNoItem) {
        // Multiattack is a narrative wrapper on other actions — not a real
        // item and nothing in the compendium will match it structurally.
        // Skip without attempting inference.
        if (name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim() === 'multiattack') continue;

        const action = skippedByName.get(name);
        if (!action) continue;

        // Phase 12.1: intent-mode bypasses the inferActionCandidates →
        // copy-patch path entirely. Intent contains the full structured shape;
        // a compendium base would be redundant at best, a mismatch at worst.
        const skippedActionStem = stripUsageSuffix(name).stem.toLowerCase();
        const overrideIntent =
          intentByName.get(skippedActionStem) ?? intentByName.get(name.toLowerCase());
        if (overrideIntent) {
          try {
            const itemPayload = await this.buildScratchItemFromIntent(overrideIntent);
            const addResult = await this.addItemsWithBatchFallback(newActor.id, [itemPayload]);
            if (addResult.added.length === 0) {
              actionsBuildFailures.push({
                name,
                error: addResult.failed[0]?.error ?? 'add returned no items',
              });
              continue;
            }
            actionsScratchBuilt.push(name);
            // Hot-patch the activity.effects[] link post-create — same reason
            // as the parser path (dnd5e strips activity.effects[]._id during
            // createEmbeddedDocuments). Generic gate: any item with effects[]
            // and a save activity gets the link re-issued.
            const newItemId = (itemPayload as any)._id;
            const payloadActivities = (itemPayload as any)?.system?.activities ?? {};
            const saveActivityEntry = Object.entries(payloadActivities).find(
              ([, act]: [string, any]) => act?.type === 'save',
            );
            const saveActivityId = saveActivityEntry?.[0];
            const itemEffects = (itemPayload as any)?.effects ?? [];
            const effectId = itemEffects[0]?._id;
            if (newItemId && saveActivityId && effectId && itemEffects.length > 0) {
              try {
                const upd: any = await this.foundryClient.query(
                  'foundry-forge-mcp.updateActorItems',
                  {
                    actorId: newActor.id,
                    updates: [{
                      _id: newItemId,
                      [`system.activities.${saveActivityId}.effects`]: itemEffects.map(
                        (eff: any) => ({ _id: eff._id, level: { min: null, max: null }, onSave: false }),
                      ),
                    }],
                  },
                );
                if (upd?.success === false) {
                  this.logger.warn(
                    `Phase 12.1 condition-link hot-patch "${name}" returned success=false`,
                    { error: upd?.error },
                  );
                }
              } catch (linkErr: any) {
                this.logger.warn(
                  `Phase 12.1 condition-link hot-patch "${name}" threw (item still has the effect, just no save link)`,
                  { error: linkErr?.message },
                );
              }
            }
          } catch (err: any) {
            actionsBuildFailures.push({ name, error: err?.message ?? String(err) });
            this.logger.warn(`Phase 12.1 intent-build "${name}" failed`, { error: err?.message });
          }
          continue;
        }

        try {
          const ranked = await this.inferActionCandidates(name, action.parsed, 3);
          const top = ranked[0];
          const confident = top && top.score.overall >= ACTION_CONFIDENCE_FLOOR;

          if (confident && top) {
            // Copy-patch path: call the module-side handler that fetches the
            // compendium item in-process on Foundry, applies our patch spec,
            // and createEmbeddedDocuments — all without the full item doc ever
            // crossing WebRTC. Fixes the 10-50KB wire payload cliff we hit on
            // direct addActorItems.
            const patchSpec = buildActionPatchSpec(action.parsed);
            const flagsPatch = {
              'foundry-forge-mcp': {
                source: 'reloaded-copy-patch',
                basePackId: top.cand.packId,
                baseItemId: top.cand.itemId,
                baseName: top.cand.name,
              },
            };
            // Phase 8: rename to the bare stem so the new item lands as
            // "Tanglefoot" (with system.uses set via patchSpec) rather than
            // "Tanglefoot (1/day)". The patchSpec.uses payload encodes the
            // "(1/day)" semantics mechanically.
            const renameTo = stripUsageSuffix(name).stem || name;
            const r: any = await this.foundryClient.query(
              'foundry-forge-mcp.addActorItemFromCompendium',
              {
                actorId: newActor.id,
                packId: top.cand.packId,
                itemId: top.cand.itemId,
                renameTo,
                patchSpec,
                flagsPatch,
              },
            );
            if (r?.success && r.added) {
              // Post-create activity patch — module-side applyPatchSpec doesn't
              // reliably land save/damage/attack/range on copy-patched items
              // (dnd5e 5.x schema validation rebuilds the ActivityCollection
              // from source and drops pre-create mutations; the post-create
              // update inside the module had its own issues). The update path
              // via updateActorItems is proven reliable, so orchestrate from
              // here: read the new item's activities, build the dot-path
              // patch, issue the update.
              // Read activity dict from the compendium source (top.doc) — this
              // is the same source the module's createEmbeddedDocuments copies
              // from, so its activity ids match the new item's. getCharacterInfo
              // was unreliable here: the freshly-created Item exposes
              // system.activities as an ActivityCollection that intermittently
              // iterates empty under for-of right after create (see the
              // addActorItemFromCompendium "doc.system.activities ... sometimes
              // returns empty" comment). The compendium doc has none of that
              // race because it's a static read.
              const sourceActivities: Record<string, any> =
                ((top.doc as any)?.system?.activities ??
                  (top.doc as any)?.fullData?.system?.activities ??
                  {}) as Record<string, any>;
              const sourceActivityIds = Object.keys(sourceActivities);
              const diag: Record<string, any> = {
                name,
                baseItemId: r.added._id,
                step: 'start',
                parsedHas: {
                  attackBonus: action.parsed.attackBonus !== undefined,
                  save: !!action.parsed.save,
                  damage: action.parsed.damage.length > 0,
                  reach: action.parsed.reach !== undefined,
                  range: !!action.parsed.range,
                },
                sourceActivityIds,
                sourceActivityTypes: sourceActivityIds.map((id) => sourceActivities[id]?.type),
              };
              copyPatchDiag.push(diag);
              try {
                if (sourceActivityIds.length === 0) {
                  diag.step = 'noSourceActivities';
                } else {
                  const activityUpdate = buildItemActivityUpdate(
                    r.added._id,
                    sourceActivities,
                    action.parsed,
                  );
                  // Phase 3A also for copy-patched items: imported compendium
                  // items carry SRD descriptions ("This sticky, adhesive
                  // fluid..."); overwrite with Reloaded prose so the sheet
                  // shows what the DM authored.
                  if (action.description) {
                    activityUpdate['system.description.value'] =
                      `<p>${escapeHtml(action.description)}</p>`;
                  }
                  diag.updateKeys = Object.keys(activityUpdate).filter((k) => k !== '_id');

                  if (diag.updateKeys.length === 0) {
                    diag.step = 'emptyUpdatePayload';
                  } else {
                    diag.step = 'sendUpdate';
                    const upd: any = await this.foundryClient.query(
                      'foundry-forge-mcp.updateActorItems',
                      { actorId: newActor.id, updates: [activityUpdate] },
                    );
                    diag.updateResult = !!upd?.success;
                    diag.updatedCount = Array.isArray(upd?.updated) ? upd.updated.length : 0;
                    diag.step = 'done';
                  }

                  // Phase 10A.2b — condition link injection on copy-patch.
                  // Same pattern as scratch-build (Phase 10A.2 + 10A.5
                  // hot-patch): when parsed.condition is set, create the
                  // item-side ActiveEffect with statuses[<cond>] and link it
                  // from the save activity's effects[]. Different from
                  // scratch-build because the item already exists, so we have
                  // to merge the new effect into the existing effects array
                  // (otherwise updateActorItems would clobber any base-side
                  // effects). Fetch-then-merge via getCharacterInfo. Save
                  // activity id is found in sourceActivities (the compendium
                  // base may have multiple activities; we pick the save one).
                  if (action.parsed.condition) {
                    const saveActId = sourceActivityIds.find(
                      (id) => sourceActivities[id]?.type === 'save',
                    );
                    if (saveActId) {
                      try {
                        const effectDoc = buildConditionEffect(action.parsed.condition);
                        // Read existing item.effects so we don't clobber any
                        // base-side effects (rare for monster items but real
                        // for some — Wolf Bite's prone effect is item-side).
                        // Requires v0.1.13+ module visibility patch.
                        const fullActor: any = await this.foundryClient.query(
                          'foundry-forge-mcp.getCharacterInfo',
                          { characterName: newActor.id },
                        );
                        const existingItem = (fullActor?.items ?? []).find(
                          (i: any) => i.id === r.added._id,
                        );
                        const existingEffects: any[] = Array.isArray(existingItem?.effects)
                          ? existingItem.effects
                          : [];
                        // Idempotency: skip if an effect with the same
                        // status already exists (covers re-running the build
                        // on an already-patched actor).
                        const alreadyHasMatchingStatus = existingEffects.some(
                          (eff: any) =>
                            (Array.isArray(eff?.statuses) ? eff.statuses : [])
                              .includes(action.parsed.condition!.type),
                        );
                        if (!alreadyHasMatchingStatus) {
                          const mergedEffects = [...existingEffects, effectDoc];
                          const linkUpd: any = await this.foundryClient.query(
                            'foundry-forge-mcp.updateActorItems',
                            {
                              actorId: newActor.id,
                              updates: [
                                {
                                  _id: r.added._id,
                                  effects: mergedEffects,
                                  [`system.activities.${saveActId}.effects`]: [
                                    {
                                      _id: effectDoc._id,
                                      level: { min: null, max: null },
                                      onSave: false,
                                    },
                                  ],
                                },
                              ],
                            },
                          );
                          diag.conditionLinkPatch = !!linkUpd?.success;
                        } else {
                          diag.conditionLinkPatch = 'skipped:already-present';
                        }
                      } catch (linkErr: any) {
                        diag.conditionLinkError = linkErr?.message ?? String(linkErr);
                        this.logger.warn(
                          `Phase 10A.2b condition-link patch "${name}" failed`,
                          { error: linkErr?.message },
                        );
                      }
                    }
                  }
                }
              } catch (patchErr: any) {
                diag.error = patchErr?.message ?? String(patchErr);
                diag.step = `error:${diag.step}`;
                this.logger.warn(
                  `copy-patch activity update "${name}" failed (item still landed with base stats)`,
                  { error: patchErr?.message },
                );
              }

              actionsCopyPatched.push({
                name,
                base: `${top.cand.packId}/${top.cand.itemId}`,
                score: Number(top.score.overall.toFixed(3)),
              });
            } else {
              actionsBuildFailures.push({
                name,
                error: r?.error ?? 'addActorItemFromCompendium returned no doc',
              });
            }
          } else {
            // Scratch-build fallback — tiny payload, goes through the normal
            // addActorItems path.
            const itemPayload = await this.buildScratchActionItem(name, action.description, action.parsed);
            const addResult = await this.addItemsWithBatchFallback(newActor.id, [itemPayload]);
            if (addResult.added.length > 0) {
              actionsScratchBuilt.push(name);

              // Phase 10A hot-patch: pre-create activity.effects = [{_id,...}]
              // gets the entry preserved BUT the _id field is silently stripped
              // by dnd5e schema validation when the referenced item-side
              // ActiveEffect doesn't yet exist at activity-creation time
              // (effects and activities are processed in parallel passes during
              // createEmbeddedDocuments — the activity validator can't see the
              // sibling effect yet). Mirrors `feedback_hot_patch_after_build.md`:
              // post-create updateActorItems with the same payload IS reliable.
              // Find the activity id we wrote in itemPayload, the effect id we
              // attached, and the new actor-item id, then re-issue the link.
              // _id is pre-set on the payload so addActorItems uses it as-is;
              // we don't have to re-query the actor to find the new item id.
              const newItemId = (itemPayload as any)._id;
              const payloadActivities = (itemPayload as any)?.system?.activities ?? {};
              // Phase 10A.7: pick the SAVE activity specifically — Bite-style
              // items have both attack + save and the effect link goes on the
              // save (the save fail is what triggers the rider effect). Falls
              // back to the only activity for save-only items (Tanglefoot).
              const saveActivityEntry = Object.entries(payloadActivities).find(
                ([, act]: [string, any]) => act?.type === 'save',
              );
              const saveActivityId = saveActivityEntry?.[0];
              const effectId = ((itemPayload as any)?.effects ?? [])[0]?._id;
              if (newItemId && saveActivityId && effectId && action.parsed?.condition) {
                try {
                  const upd: any = await this.foundryClient.query(
                    'foundry-forge-mcp.updateActorItems',
                    {
                      actorId: newActor.id,
                      updates: [{
                        _id: newItemId,
                        [`system.activities.${saveActivityId}.effects`]: [
                          { _id: effectId, level: { min: null, max: null }, onSave: false },
                        ],
                      }],
                    },
                  );
                  if (upd?.success === false) {
                    this.logger.warn(
                      `Phase 10A condition-link hot-patch "${name}" returned success=false`,
                      { error: upd?.error },
                    );
                  }
                } catch (linkErr: any) {
                  this.logger.warn(
                    `Phase 10A condition-link hot-patch "${name}" threw (item still has the effect, just no save link)`,
                    { error: linkErr?.message },
                  );
                }
              }
            } else {
              actionsBuildFailures.push({
                name,
                error: addResult.failed[0]?.error ?? 'add returned no items',
              });
            }
          }
        } catch (err: any) {
          actionsBuildFailures.push({ name, error: err?.message ?? String(err) });
          this.logger.warn(`Phase 3b action build "${name}" failed`, { error: err?.message });
        }
      }

      // 10. Phase 5: portrait wire-up. Either an explicit path or a fuzzy
      //     lookup against a Forge folder (Beneos cos_tokens by default).
      //     Best-effort: failures don't fail the build — we surface them in
      //     `portraitResult` so the caller can retry / supply an explicit path.
      //
      //     Arc I AAR 2026-05-19: when the caller didn't pass `portrait`
      //     explicitly, attempt to auto-resolve from the vault NPC's
      //     `portrait_canon` frontmatter. This eliminates the
      //     forgot-to-apply-portrait failure mode where actors landed
      //     with DDB compendium defaults (Baba Lysaga's
      //     `2014-cos-baba-lysaga.webp`) because the agent built the
      //     actor and then never followed up with apply-actor-portrait.
      //     Vault read is best-effort; if it fails (no env var, no file,
      //     no `portrait_canon` field), we fall back to the caller's
      //     `portrait` arg (which may be undefined, in which case the
      //     resolver behaves as before).
      let portraitArg = input.portrait;
      let portraitAutoCanon: string | null = null;
      if (!portraitArg) {
        try {
          const { readPortraitCanonFromVault } = await import('../utils/vault-reader.js');
          const lookup = readPortraitCanonFromVault(newActor.name);
          if (lookup && lookup.portraitCanon) {
            portraitAutoCanon = lookup.portraitCanon;
            if (lookup.portraitCanon === 'beneos') {
              portraitArg = {
                lookup: {
                  folder: DEFAULT_BENEOS_TOKEN_FOLDER,
                  recursive: true,
                  minScore: PORTRAIT_MATCH_FLOOR,
                },
                convention: 'auto',
              } as any;
            } else if (lookup.portraitCanon === 'custom') {
              // Klein-generated custom portrait lives at
              // cos-npc-portraits/<Display Name>.png (capitalisation +
              // spaces preserved). Apply as explicit path; the URL is
              // assembled by Foundry from the Forge asset key.
              const fileBase = encodeURIComponent(newActor.name);
              portraitArg = {
                path: `cos-npc-portraits/${fileBase}.png`,
                convention: 'single',
              } as any;
            }
            // 'needs-upgrade' → intentionally leave portraitArg undefined
            // so the compendium-base default stays as the placeholder.
          }
        } catch (vaultErr: any) {
          this.logger.warn('Vault portrait_canon auto-lookup failed; falling back', {
            actor: newActor.name,
            error: vaultErr?.message,
          });
        }
      }
      const portraitResult = await this.resolveAndApplyPortrait(
        newActor,
        sb,
        portraitArg,
      );
      if (portraitAutoCanon && portraitResult && typeof portraitResult === 'object') {
        (portraitResult as any).autoResolvedCanon = portraitAutoCanon;
      }

      // 11. Phase 3b extension: opt-in pruning of compendium-base feats not
      //     mentioned in Reloaded. Re-fetches actor items so flags on freshly
      //     added items (Reloaded traits / scratch-built actions / copy-patched
      //     items) are visible to the keep-set check. Failures are surfaced in
      //     the response, never raised — pruning is best-effort.
      // Default flipped 2026-05-17 per Arc H AAR. See shouldRunBasePrune docstring.
      let pruneResult: any = undefined;
      if (shouldRunBasePrune(input)) {
        pruneResult = await this.runBaseItemPrune(
          newActor.id,
          sb,
          allReloadedActions.map(a => a.name),
        );
      }

      // 12. Arc I AAR 2026-05-19: auto-apply feat icon retrofit. Workflow
      //     Phase C step 6 calls it out as required — caller was forgetting
      //     on every build, leaving scratch-built feats (Hair Blades,
      //     Devouring Flies, Skilled Casting, Swampwalk, etc.) on the
      //     generic `feature.svg` / `activity/save.svg` placeholders.
      //     Mirrors the auto-portrait pattern at step 10. Best-effort —
      //     a failure here doesn't sink the build but is surfaced on the
      //     `featIcons` result for the caller's audit.
      let featIconsResult: any = undefined;
      try {
        const { ApplyFeatIconsTools } = await import('./apply-feat-icons.js');
        const featIconsTool = new ApplyFeatIconsTools({
          foundryClient: this.foundryClient,
          logger: this.logger,
        });
        featIconsResult = await featIconsTool.handleApplyFeatIcons({
          actorId: newActor.id,
          // includeFallback=true so the generic-feature fallback IS applied
          // for any feat the themed resolver can't match. Better generic
          // theme than the dnd5e default star.
          includeFallback: true,
        });
      } catch (featErr: any) {
        featIconsResult = { error: featErr?.message ?? String(featErr) };
        this.logger.warn('Auto apply-feat-icons failed; actor build still committed', {
          actorId: newActor.id, error: featErr?.message,
        });
      }

      // 13. 2026-05-25: bulletproof equipped-weapon sweep. The intent-writer
      //     fix (writeActivityUpdate emits system.equipped: true) covers
      //     every weapon that goes through the activity patch loop, but
      //     items spawned from the compendium base with no Reloaded action
      //     match (and that survive prune) keep whatever equipped value the
      //     base shipped with. Tokens entering combat with zero equipped
      //     melee weapons never get flags["midi-qol"].actions initialized,
      //     which silently disables Gambit's Premades Opportunity Attack
      //     auto-prompt for the entire encounter (confirmed 2026-05-25 on
      //     Volenta + Vampire Spawn). This sweep is the belt-and-suspenders
      //     guarantee — re-read the actor, force-equip every weapon item
      //     not already equipped. Best-effort: failure surfaces on the
      //     `equippedWeaponSweep` field but does not sink the build.
      let equippedWeaponSweep: any = undefined;
      try {
        const finalActor: any = await this.foundryClient.query(
          'foundry-forge-mcp.getCharacterInfo',
          { characterName: newActor.id },
        );
        const finalItems = finalActor?.items ?? finalActor?.character?.items ?? [];
        const toEquip = finalItems
          .filter((it: any) => it.type === 'weapon' && it.system?.equipped !== true)
          .map((it: any) => ({ _id: it.id ?? it._id, name: it.name }));
        if (toEquip.length > 0) {
          await this.foundryClient.query('foundry-forge-mcp.updateActorItems', {
            actorId: newActor.id,
            updates: toEquip.map((w: any) => ({ _id: w._id, 'system.equipped': true })),
          });
          equippedWeaponSweep = { patched: toEquip };
        } else {
          equippedWeaponSweep = { patched: [] };
        }
      } catch (sweepErr: any) {
        equippedWeaponSweep = { error: sweepErr?.message ?? String(sweepErr) };
        this.logger.warn('Post-spawn equipped-weapon sweep failed; actor build still committed', {
          actorId: newActor.id, error: sweepErr?.message,
        });
      }

      return {
        success: true,
        actorId: newActor.id,
        actorName: newActor.name,
        compendiumBase: base,
        parsed: {
          name: sb.name,
          challenge: sb.challenge,
          ac: sb.ac,
          hp: sb.hp,
          speed: sb.speed,
          proficiencyBonus: sb.proficiencyBonus,
          skills: sb.skills,
          senses: sb.sensesText,
          languages: sb.languages,
        },
        appliedUpdates: successfulUpdateKeys.filter(k => !k.startsWith('flags.')),
        failedUpdateChunks,
        traitsAdded: addedTraitNames,
        traitAddFailures,
        traitsAlreadyPresent: sb.traits
          .filter(t => existingItemNames.has(t.name.toLowerCase()))
          .map(t => t.name),
        actionsSynced: actionsSynced.filter(n => !actionSyncFailures.find(f => f.name === n)),
        actionsCopyPatched,
        copyPatchDiag,
        actionsScratchBuilt,
        actionsBuildFailures,
        actionsSkippedNoItem,
        actionsSkippedNoActivity,
        actionSyncFailures,
        portrait: portraitResult,
        prune: pruneResult,
        featIcons: featIconsResult,
        equippedWeaponSweep,
        flagsStamped: ['foundry-forge-mcp.source', 'foundry-forge-mcp.reloadedName']
          .concat(input.file_path ? ['foundry-forge-mcp.reloadedPath'] : []),
        notes: [
          'Phase 3a-B: numeric overrides + skills/senses/languages/immunities/prof-bonus applied; Reloaded-only traits added as simple feats.',
          'Phase 3a-C: existing action items updated with Reloaded attack bonus, damage parts, save DC, reach/range (targeting the item\'s primary attack/save activity).',
          'Phase 3a-polish: activity range carries override=true so the activity\'s stored value beats the compendium base (was bleeding through on weapons like Hail of Daggers).',
          'Phase 3a-polish: versatile alternative damage (e.g. "or 2d10+4 if two-handed") writes to item-level system.damage.versatile so the sheet exposes the second roll.',
          'Reloaded-only ACTIONS (not traits) that don\'t exist on the compendium base are not auto-created yet — add manually or wait for a follow-up phase.',
          'prune_base_items defaults to true (flipped 2026-05-17 per Arc H AAR). Pass `prune_base_items: false` ONLY for Mode C passthrough builds where Reloaded prose paraphrases base features verbatim (Arc F Ernst Larnak case). Pruning is conservative and reports kept + pruned items.',
          'Actor landed in default folder "Foundry MCP Creatures" — move manually for now.',
        ],
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-actor', 'actor creation');
    }
  }

  /**
   * Phase 12.1.3 — batch create. Iterates `actors` and calls handleCreateActor
   * per entry, with per-actor failure isolation: a thrown error from one entry
   * is caught, logged, and recorded in results — the rest of the batch
   * continues. Sequential execution (Foundry's createEmbeddedDocuments isn't
   * built for concurrent multi-actor creation; one race observed in 3a-polish
   * around addActorItems batches gave us the conservative default).
   *
   * Each entry follows the create-actor inputSchema (Mode A/B/C/D/E). The
   * tool returns aggregate counts + a per-entry result with the original
   * input's name and either the new actorId or the error message.
   */
  async handleCreateActorsBatch(args: any): Promise<any> {
    const schema = z.object({
      actors: z.array(z.any()).min(1),
    });
    const input = schema.parse(args);

    this.logger.info('create-actors batch invoked', { count: input.actors.length });

    type Result = {
      index: number;
      name: string;
      success: boolean;
      actorId?: string;
      error?: string;
      detail?: any;
    };
    const results: Result[] = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < input.actors.length; i++) {
      const entry = input.actors[i];
      const name = this.batchEntryName(entry, i);
      try {
        const detail = await this.handleCreateActor(entry);
        const actorId =
          (detail as any)?.actorId ?? (detail as any)?.actor?.id ?? undefined;
        results.push({
          index: i,
          name,
          success: true,
          ...(actorId ? { actorId } : {}),
          detail,
        });
        succeeded++;
      } catch (err: any) {
        const message = err?.message ?? String(err);
        results.push({ index: i, name, success: false, error: message });
        failed++;
        this.logger.warn(`create-actors batch[${i}] "${name}" failed`, {
          error: message,
        });
      }
    }

    return {
      total: input.actors.length,
      succeeded,
      failed,
      results,
    };
  }

  private batchEntryName(entry: any, idx: number): string {
    return batchEntryName(entry, idx);
  }

  /**
   * Mode B — prose-spec build. Reloaded references a base creature with
   * narrative ("retains the statistics of a **priest**") and optionally
   * overrides specific feature descriptions ("his ***Divine Eminence***
   * feature now reads as follows: ..."). We spawn the base and apply only
   * the overrides Reloaded specifies.
   */
  private async runProseBuild(
    spec: ReloadedProseSpec,
    input: any,
  ): Promise<any> {
    this.logger.info('create-actor prose-mode', {
      name: spec.name,
      baseHint: spec.baseHint,
      overrideCount: spec.featureOverrides.length,
    });

    // Find the base. Either explicit compendium_base or search by baseHint.
    const base = input.compendium_base ?? (spec.baseHint
      ? await this.searchForCompendiumBase(spec.baseHint)
      : null);
    if (!base) {
      throw new Error(
        `Prose-mode build needs a compendium base. Reloaded prose ${spec.baseHint
          ? `references "${spec.baseHint}" but no compendium match was found`
          : 'does not name a base creature'}. Pass compendium_base explicitly.`,
      );
    }

    const actorName = spec.name ?? input.actor_name ?? 'Unnamed';
    const newActor = await this.spawnFromCompendium(base, actorName);

    // Apply feature overrides — find each feature item by name on the spawned
    // actor, replace its description with Reloaded's prose. Failures isolated.
    const overrideResult = spec.featureOverrides.length > 0
      ? await this.applyFeatureOverrides(newActor.id, spec.featureOverrides)
      : { applied: [], failed: [] };

    // Stamp source flags so audit-actor can recognize prose-built actors.
    await this.stampProseFlags(newActor.id, spec, input);

    // Apply portrait (Phase 5) — same path as Mode A.
    const portraitResult = await this.resolveAndApplyPortrait(
      newActor,
      // Synthesize a minimal ReloadedStatblock for nameVariants() — only `.name` is read.
      { name: actorName } as any,
      input.portrait,
    );

    return {
      success: true,
      mode: 'prose',
      actorId: newActor.id,
      actorName: newActor.name,
      compendiumBase: base,
      parsed: {
        name: spec.name,
        baseHint: spec.baseHint,
        overrideCount: spec.featureOverrides.length,
      },
      featureOverridesApplied: overrideResult.applied,
      featureOverrideFailures: overrideResult.failed,
      portrait: portraitResult,
      notes: [
        'Mode B (prose): spawned from compendium base referenced in Reloaded prose, ' +
        'applied feature description overrides only. Numeric stats / actions / traits ' +
        'come unmodified from the compendium base (Reloaded prose-mode only rewrites ' +
        'feature descriptions, not stats).',
      ],
    };
  }

  /**
   * Mode C — pure passthrough. No Reloaded source, just spawn the named
   * compendium actor and apply portrait. For NPCs whose Reloaded entry is
   * just a reference (Rictavio: "use the Rictavio in DDB compendium").
   */
  private async runPassthroughBuild(input: any): Promise<any> {
    if (!input.compendium_base) {
      throw new Error('Passthrough mode requires compendium_base.');
    }
    this.logger.info('create-actor passthrough-mode', {
      base: input.compendium_base,
      actorName: input.actor_name,
    });

    const actorName = input.actor_name; // optional; if undefined, spawn uses compendium entry name
    const newActor = await this.spawnFromCompendium(input.compendium_base, actorName);

    const portraitResult = await this.resolveAndApplyPortrait(
      newActor,
      { name: newActor.name } as any,
      input.portrait,
    );

    return {
      success: true,
      mode: 'passthrough',
      actorId: newActor.id,
      actorName: newActor.name,
      compendiumBase: input.compendium_base,
      portrait: portraitResult,
      notes: [
        'Mode C (passthrough): spawned from compendium with no Reloaded modifications. ' +
        'The actor is the compendium entry as-is, plus any portrait specified.',
      ],
    };
  }

  /**
   * Spawn an actor from a compendium pack, optionally renaming. Wraps the
   * createActorFromCompendium query so all three modes share one path.
   */
  private async spawnFromCompendium(
    base: { packId: string; itemId: string },
    actorName: string | undefined,
  ): Promise<{ id: string; name: string }> {
    if (actorName) {
      await this.ensureNoDuplicateInStaging(actorName);
    }
    const params: any = {
      packId: base.packId,
      itemId: base.itemId,
      quantity: 1,
      addToScene: false,
    };
    if (actorName) params.customNames = [actorName];
    const spawn: any = await this.foundryClient.query('foundry-forge-mcp.createActorFromCompendium', params);
    if (!spawn?.success || !spawn.actors?.length) {
      throw new Error(
        `Compendium spawn failed for pack=${base.packId} item=${base.itemId}: ${spawn?.errors?.join('; ') ?? 'unknown error'}`,
      );
    }
    const actor = spawn.actors[0] as { id: string; name: string };
    this.logger.info('Actor spawned from compendium', { id: actor.id, name: actor.name });
    return actor;
  }

  /**
   * Arc I AAR 2026-05-19 / shipped 2026-05-22 — duplicate-actor refusal.
   *
   * Before any spawn into the `Foundry MCP Creatures` staging folder,
   * verify no actor with the same name already exists. If one does,
   * throw with the existing actor's id so the caller can delete the
   * stray manually and retry. Matches the standing "user manually
   * promotes / deletes" pattern in workflow-arc-generation.md Phase B
   * step 5.
   *
   * Why exact-name (case-insensitive) match: nameContains substring would
   * trip on legitimate sibling names like "Baba Lysaga" vs "Baba Lysaga,
   * Witch Mother" (the multi-form pattern). Use nameContains as the
   * server-side filter for efficiency, then exact-equal client-side.
   *
   * Pre-existing failure mode this closes: Arc I had a stray
   * `Baba Lysaga, Witch Mother` (id TMa7ZixWbZsFb8z1, HP 120, unpruned
   * base Quarterstaff + Summon Swarms of Insects) sitting alongside the
   * real one (HP 135, clean) for hours. The stray came from an earlier
   * failed create-actor call where the spawn succeeded but the
   * downstream patch failed — the user only noticed during cleanup.
   */
  private async ensureNoDuplicateInStaging(name: string): Promise<void> {
    const STAGING_FOLDER = 'Foundry MCP Creatures';
    let existing: any[];
    try {
      const result: any = await this.foundryClient.query(
        'foundry-forge-mcp.listActors',
        { folder: STAGING_FOLDER, nameContains: name },
      );
      const items = Array.isArray(result)
        ? result
        : (Array.isArray(result?.items) ? result.items : []);
      existing = items.filter((a: any) =>
        typeof a?.name === 'string' && a.name.toLowerCase() === name.toLowerCase()
      );
    } catch (err: any) {
      // Best-effort — a listActors failure here shouldn't sink the build.
      // Better to spawn-and-risk-duplicate than block on a transient
      // bridge hiccup.
      this.logger.warn('Duplicate-name pre-check failed; proceeding with spawn', {
        name, error: err?.message,
      });
      return;
    }
    if (existing.length === 0) return;
    const existingIds = existing.map((a: any) => a.id ?? a._id).filter(Boolean);
    throw new Error(
      `Actor "${name}" already exists in "${STAGING_FOLDER}" ` +
      `(id${existing.length > 1 ? 's' : ''}: ${existingIds.join(', ')}). ` +
      `Delete the stray manually in Foundry and retry. Duplicates from ` +
      `earlier failed builds are the most common cause — verify the ` +
      `existing actor's HP/items match the Reloaded source before ` +
      `keeping it; an HP/item mismatch signals an aborted build.`,
    );
  }

  /**
   * Apply prose-style feature description overrides. Looks up each feature
   * by name on the actor's items list (case-insensitive), replaces its
   * `system.description.value` with Reloaded's prose (HTML-escaped + wrapped
   * in <p>). Failures are captured per-override and returned, never thrown.
   */
  private async applyFeatureOverrides(
    actorId: string,
    overrides: FeatureOverride[],
  ): Promise<{ applied: string[]; failed: Array<{ name: string; error: string }> }> {
    // Pull current items so we can map name → id.
    const actorFull: any = await this.foundryClient.query(
      'foundry-forge-mcp.getCharacterInfo',
      { characterName: actorId },
    );
    const itemsByLcName = new Map<string, any>();
    for (const item of actorFull?.items ?? []) {
      const n = String(item.name ?? '').toLowerCase();
      if (n) itemsByLcName.set(n, item);
    }

    const applied: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (const ov of overrides) {
      const item = itemsByLcName.get(ov.name.toLowerCase());
      if (!item) {
        failed.push({ name: ov.name, error: `Feature "${ov.name}" not found on actor` });
        continue;
      }
      try {
        const update = {
          _id: item.id,
          'system.description.value': `<p>${escapeHtml(ov.description)}</p>`,
        };
        const r: any = await this.foundryClient.query('foundry-forge-mcp.updateActorItems', {
          actorId,
          updates: [update],
        });
        if (r?.success === false) {
          failed.push({ name: ov.name, error: r?.error ?? 'updateActorItems success=false' });
        } else {
          applied.push(ov.name);
        }
      } catch (err: any) {
        failed.push({ name: ov.name, error: err?.message ?? String(err) });
      }
    }

    return { applied, failed };
  }

  /** Stamp source flags so audit-actor distinguishes prose-built from statblock-built. */
  private async stampProseFlags(
    actorId: string,
    spec: ReloadedProseSpec,
    input: any,
  ): Promise<void> {
    const updates: Record<string, any> = {
      'flags.foundry-forge-mcp.source': 'reloaded-prose',
    };
    if (spec.name) updates['flags.foundry-forge-mcp.reloadedName'] = spec.name;
    if (input.file_path) updates['flags.foundry-forge-mcp.reloadedPath'] = input.file_path;
    updates['flags.foundry-forge-mcp.createdAt'] = new Date().toISOString();
    try {
      await this.foundryClient.query('foundry-forge-mcp.updateActorData', { actorId, updates });
    } catch (err: any) {
      this.logger.warn('stampProseFlags failed (non-fatal)', { error: err?.message ?? String(err) });
    }
  }

  async handleInferBaseMonster(args: any): Promise<any> {
    const schema = z.object({
      reloaded_source: z.string().optional(),
      file_path: z.string().optional(),
      creature_name: z.string().optional(),
      top_n: z.number().min(1).max(10).default(5),
    }).refine(
      d => d.reloaded_source || (d.file_path && d.creature_name),
      { message: 'Provide reloaded_source OR both file_path and creature_name' },
    );
    const input = schema.parse(args);

    this.logger.info('infer-base-monster invoked', {
      hasSource: !!input.reloaded_source,
      filePath: input.file_path,
      creatureName: input.creature_name,
      topN: input.top_n,
    });

    try {
      const markdown = await this.resolveSource(input);
      const sb = parseReloadedStatblock(markdown);
      const normalizedType = normalizeCreatureType(sb.type);
      const normalizedSize = normalizeSize(sb.size);

      // Build criteria query. CR window ±2 around Reloaded CR; fall back to
      // the full CR spectrum if Reloaded didn't give us a numeric (rare).
      const crMin = sb.challengeNumeric !== null ? Math.max(0, sb.challengeNumeric - 2) : 0;
      const crMax = sb.challengeNumeric !== null ? sb.challengeNumeric + 2 : 30;
      const criteriaParams: Record<string, any> = {
        challengeRating: { min: crMin, max: crMax },
        limit: 500,
      };
      if (normalizedType) criteriaParams.creatureType = normalizedType;
      if (normalizedSize && SIZE_CODE_TO_WORD_LOCAL[normalizedSize]) {
        criteriaParams.size = SIZE_CODE_TO_WORD_LOCAL[normalizedSize];
      }

      this.logger.debug('infer-base-monster criteria', criteriaParams);
      const rawResult: any = await this.foundryClient.query(
        'foundry-forge-mcp.listCreaturesByCriteria',
        criteriaParams,
      );
      const creatures: any[] = rawResult?.response?.creatures ?? rawResult?.creatures ?? [];
      this.logger.info('infer-base-monster candidate pool', { count: creatures.length });

      // Normalize each candidate to CandidateBasic shape so the scorer can
      // consume it uniformly.
      const basic: CandidateBasic[] = creatures
        .map(c => this.creatureToBasic(c))
        .filter(c => passesHardFilters(sb, c));

      if (basic.length === 0) {
        return {
          parsed: this.summarizeParsed(sb),
          candidates: [],
          topPick: null,
          confidence: 'low' as const,
          recommendation:
            `No candidates passed hard filters (type=${normalizedType ?? '?'}, CR=${crMin}..${crMax}). ` +
            `Consider scratch-build, or widen CR window by passing an explicit compendium_base to create-actor.`,
        };
      }

      // Cheap pre-score + rank; cap the expensive full-doc fetches to 8.
      const prescored = basic
        .map(c => ({ c, pre: preScore(sb, c) }))
        .sort((a, b) => b.pre - a.pre)
        .slice(0, 8);
      this.logger.debug('infer-base-monster pre-score top', {
        picks: prescored.map(p => ({ name: p.c.name, pre: Number(p.pre.toFixed(3)) })),
      });

      // Fetch full docs in parallel so we can score trait/action overlap.
      const fullResults = await Promise.all(prescored.map(async ({ c }) => {
        try {
          const doc: any = await this.foundryClient.query(
            'foundry-forge-mcp.getCompendiumDocumentFull',
            { packId: c.packId, documentId: c.itemId },
          );
          return { c, full: this.docToCandidateFull(c, doc) };
        } catch (err) {
          this.logger.warn('getCompendiumDocumentFull failed; dropping candidate', {
            name: c.name, packId: c.packId, itemId: c.itemId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }));

      const scored = fullResults
        .filter((r): r is { c: CandidateBasic; full: CandidateFull } => r !== null)
        .map(({ full }) => ({ cand: full, score: scoreCandidate(sb, full) }))
        .sort((a, b) => b.score.overall - a.score.overall);

      const top = scored.slice(0, input.top_n);
      const topScore = top[0]?.score.overall ?? 0;
      const confidence = topScore >= CONFIDENCE_FLOOR ? 'high' : 'low';

      return {
        parsed: this.summarizeParsed(sb),
        candidatePoolSize: creatures.length,
        passedHardFilters: basic.length,
        candidates: top.map((s, idx) => ({
          rank: idx + 1,
          packId: s.cand.packId,
          itemId: s.cand.itemId,
          name: s.cand.name,
          cr: s.cand.cr,
          score: Number(s.score.overall.toFixed(3)),
          components: Object.fromEntries(
            Object.entries(s.score.components).map(([k, v]) => [k, Number(v.toFixed(3))]),
          ),
          rationale: s.score.rationale,
        })),
        topPick: top[0] ? {
          packId: top[0].cand.packId,
          itemId: top[0].cand.itemId,
          name: top[0].cand.name,
          score: Number(top[0].score.overall.toFixed(3)),
        } : null,
        confidence,
        recommendation: confidence === 'high'
          ? `Pass compendium_base={packId: "${top[0].cand.packId}", itemId: "${top[0].cand.itemId}"} to create-actor.`
          : `Top candidate ${top[0]?.cand.name ?? 'n/a'} scored ${topScore.toFixed(2)} below confidence floor ${CONFIDENCE_FLOOR}. Ask user before proceeding, or use scratch-build.`,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'infer-base-monster', 'base monster inference');
    }
  }

  /** Convert a list-creatures-by-criteria item to our scorer input shape. */
  private creatureToBasic(c: any): CandidateBasic {
    const system = c.system ?? {};
    // HP/AC are not returned by formatCreatureListItem, but some callers pass
    // the raw system blob. Try both paths.
    const hpMax = system.attributes?.hp?.max ?? system.hp?.max ?? null;
    const acVal = system.attributes?.ac?.value ?? system.ac?.value ?? null;
    return {
      packId: c.pack?.id ?? c.pack ?? c.packId ?? '',
      itemId: c.id ?? c.itemId ?? c._id ?? '',
      name: c.name ?? '',
      cr: typeof c.challengeRating === 'number' ? c.challengeRating
        : typeof c.cr === 'number' ? c.cr
        : typeof system.details?.cr === 'number' ? system.details.cr
        : null,
      creatureType: normalizeCreatureType(c.creatureType ?? system.details?.type?.value ?? null),
      size: normalizeSize(c.size ?? system.traits?.size ?? null),
      hp: typeof hpMax === 'number' ? hpMax : null,
      ac: typeof acVal === 'number' ? acVal : null,
    };
  }

  /** Merge a full compendium document into the CandidateFull shape. */
  private docToCandidateFull(basic: CandidateBasic, doc: any): CandidateFull {
    const system = doc?.system ?? {};
    const abilities = {
      str: system.abilities?.str?.value ?? 10,
      dex: system.abilities?.dex?.value ?? 10,
      con: system.abilities?.con?.value ?? 10,
      int: system.abilities?.int?.value ?? 10,
      wis: system.abilities?.wis?.value ?? 10,
      cha: system.abilities?.cha?.value ?? 10,
    };
    const items: any[] = doc?.items ?? [];
    const featNames = new Set<string>(
      items.filter(i => i.type === 'feat').map(i => String(i.name ?? '').toLowerCase()).filter(Boolean),
    );
    const itemNames = new Set<string>(
      items.map(i => String(i.name ?? '').toLowerCase()).filter(Boolean),
    );
    // Fill in the HP/AC we couldn't get from the list step.
    const hp = typeof system.attributes?.hp?.max === 'number' ? system.attributes.hp.max : basic.hp;
    const ac = typeof system.attributes?.ac?.value === 'number' ? system.attributes.ac.value : basic.ac;
    return { ...basic, hp, ac, abilities, featNames, itemNames };
  }

  private summarizeParsed(sb: ReloadedStatblock) {
    return {
      name: sb.name,
      size: sb.size,
      type: sb.type,
      challenge: sb.challenge,
      challengeNumeric: sb.challengeNumeric,
      ac: sb.ac,
      hp: sb.hp.avg,
      traitCount: sb.traits.length,
      actionCount: sb.actions.length + sb.bonusActions.length + sb.reactions.length
        + sb.legendaryActions.length + sb.lairActions.length,
    };
  }

  async handleInferBaseAction(args: any): Promise<any> {
    const schema = z.object({
      action_name: z.string().min(1),
      action_description: z.string().optional(),
      top_n: z.number().min(1).max(10).default(3),
    });
    const input = schema.parse(args);

    const parsed = parseActionDescription(input.action_description ?? '') ?? { damage: [] };

    const ranked = await this.inferActionCandidates(input.action_name, parsed, input.top_n);
    const top = ranked[0];
    const confidence = (top?.score.overall ?? 0) >= ACTION_CONFIDENCE_FLOOR ? 'high' : 'low';

    return {
      action: { name: input.action_name, parsed: summarizeParsedAction(parsed) },
      candidates: ranked.slice(0, input.top_n).map((s, idx) => ({
        rank: idx + 1,
        packId: s.cand.packId,
        itemId: s.cand.itemId,
        name: s.cand.name,
        type: s.cand.type,
        score: Number(s.score.overall.toFixed(3)),
        components: Object.fromEntries(
          Object.entries(s.score.components).map(([k, v]) => [k, Number(v.toFixed(3))]),
        ),
        rationale: s.score.rationale,
      })),
      topPick: top ? {
        packId: top.cand.packId,
        itemId: top.cand.itemId,
        name: top.cand.name,
        type: top.cand.type,
        score: Number(top.score.overall.toFixed(3)),
      } : null,
      confidence,
      recommendation: confidence === 'high'
        ? `Copy-patch "${top!.cand.name}" from ${top!.cand.packId} as the base for "${input.action_name}".`
        : `No base above confidence floor ${ACTION_CONFIDENCE_FLOOR} — scratch-build a feat with description-only for "${input.action_name}".`,
    };
  }

  /**
   * Given an action name + parsed data, search the compendium via name
   * variants, pull full docs for the top hits, and rank. Returns candidates
   * sorted best-first.
   */
  private async inferActionCandidates(
    actionName: string,
    parsed: ParsedAction,
    topN: number,
  ): Promise<Array<{ cand: ActionCandidateFull; score: ReturnType<typeof scoreActionCandidate>; doc: any }>> {
    // 1. Collect unique name-based hits across all variants.
    const uniqueBasic = new Map<string, ActionCandidateBasic>();
    for (const variant of actionNameVariants(actionName)) {
      let raw: any;
      try {
        raw = await this.foundryClient.query('foundry-forge-mcp.searchCompendium', {
          query: variant,
          packType: 'Item',
        });
      } catch (err) {
        this.logger.warn('searchCompendium variant failed', { variant, error: (err as any)?.message });
        continue;
      }
      for (const hit of extractSearchHits(raw)) {
        const packId = hit.packId ?? hit.pack?.id ?? hit.pack;
        const itemId = hit.id ?? hit.itemId ?? hit._id;
        if (!packId || !itemId) continue;
        const key = `${packId}:${itemId}`;
        if (uniqueBasic.has(key)) continue;
        uniqueBasic.set(key, {
          packId,
          itemId,
          name: hit.name ?? '',
          type: hit.type ?? '',
        });
      }
    }

    // 2. Hard-filter and cap candidate pool to top 6 by cheap name-similarity.
    const filtered = [...uniqueBasic.values()].filter(c => passesActionHardFilters(parsed, c));
    if (filtered.length === 0) return [];
    const preRanked = filtered
      .map(c => ({ c, preScore: cheapNameScore(actionName, c.name) }))
      .sort((a, b) => b.preScore - a.preScore)
      .slice(0, 6);

    // 3. Fetch full docs in parallel so we can compute damage types + activity types.
    const fullResults = await Promise.all(preRanked.map(async ({ c }) => {
      try {
        const doc: any = await this.foundryClient.query(
          'foundry-forge-mcp.getCompendiumDocumentFull',
          { packId: c.packId, documentId: c.itemId },
        );
        return { c, full: docToActionCandidateFull(c, doc), doc };
      } catch (err) {
        this.logger.warn('getCompendiumDocumentFull for action failed', {
          name: c.name, packId: c.packId, itemId: c.itemId,
          error: (err as any)?.message,
        });
        return null;
      }
    }));

    // 4. Score and sort best-first.
    return fullResults
      .filter((r): r is { c: ActionCandidateBasic; full: ActionCandidateFull; doc: any } => r !== null)
      .map(r => ({ cand: r.full, score: scoreActionCandidate(parsed, r.full, actionName), doc: r.doc }))
      .sort((a, b) => b.score.overall - a.score.overall)
      .slice(0, topN);
  }

  /**
   * Fallback when no compendium base passes the confidence floor. Builds a
   * minimal feat item with name + description (HTML) only. Not wired for
   * MidiQOL — the DM sees the printed action but has to roll manually.
   */
  /**
   * Phase 5 portrait orchestration. Three paths:
   *   - explicit `path` → just call setActorImage
   *   - `lookup` → browse Forge folder, fuzzy-match creature name, apply if
   *     score ≥ minScore (default 0.5); otherwise return candidates so the
   *     caller can pick manually.
   *   - omitted → no-op, return `{ applied: false, reason: 'not_requested' }`.
   *
   * Best-effort: a Forge browse/apply failure is captured into the result
   * shape, never thrown. The actor build is the headline; portrait is a nice-
   * to-have that shouldn't roll back combat math if the asset library is down.
   */
  // Public so apply-actor-portrait (standalone tool) can delegate to the same
  // resolver/pair-detector/apply pipeline create-actor uses for new builds.
  // No state beyond `this`; safe to call from other tools that hold a ref.
  public async resolveAndApplyPortrait(
    actor: { id: string; name: string },
    sb: ReloadedStatblock,
    options:
      | {
          path?: string | undefined;
          lookup?: {
            folder?: string | undefined;
            minScore?: number | undefined;
            names?: string[] | undefined;
            recursive?: boolean | undefined;
          } | undefined;
          convention?: 'auto' | 'single' | 'tokenizer' | undefined;
          applyToToken?: boolean | undefined;
        }
      | undefined,
  ): Promise<Record<string, any>> {
    if (!options) return { applied: false, reason: 'not_requested' };

    const convention = options.convention ?? 'auto';
    const applyToToken = options.applyToToken ?? true;

    // Mode 1: explicit path. With convention=tokenizer, only `img` is set.
    // With auto/single + applyToToken=true, both fields get the same URL
    // (no pair detection — caller knew exactly what file to apply).
    if (options.path) {
      try {
        if (convention === 'tokenizer') {
          await this.applyActorPortraitOnly(actor.id, options.path);
        } else {
          await this.applyActorImage(actor.id, options.path, applyToToken);
        }
        return {
          applied: true,
          mode: 'explicit',
          convention,
          portraitUrl: options.path,
          tokenUrl: convention === 'tokenizer' ? null : (applyToToken ? options.path : null),
          tokenUpdated: convention !== 'tokenizer' && applyToToken,
        };
      } catch (err: any) {
        return {
          applied: false,
          mode: 'explicit',
          convention,
          portraitUrl: options.path,
          error: err?.message ?? String(err),
        };
      }
    }

    // Mode 2: fuzzy lookup against a Forge folder (recursive by default).
    if (options.lookup) {
      if (!this.forgeAssetsClient) {
        return {
          applied: false, mode: 'lookup',
          reason: 'forge_client_unavailable',
          hint: 'Set FORGE_ASSETS_API_KEY in the backend env to enable folder lookup.',
        };
      }

      const folder = options.lookup.folder ?? DEFAULT_BENEOS_TOKEN_FOLDER;
      const minScore = options.lookup.minScore ?? PORTRAIT_MATCH_FLOOR;
      const recursive = options.lookup.recursive ?? true;

      let entries: ForgeAssetEntry[] = [];
      try {
        entries = await this.forgeAssetsClient.browseFolder(folder, { recursive });
      } catch (err: any) {
        return {
          applied: false, mode: 'lookup', folder,
          error: err?.message ?? String(err),
        };
      }
      if (entries.length === 0) {
        return { applied: false, mode: 'lookup', folder, reason: 'empty_folder' };
      }

      // Candidate names: caller override OR the standard nameVariants (full,
      // pre-comma stem, role-stripped) used by compendium matching.
      const candidates = options.lookup.names && options.lookup.names.length > 0
        ? options.lookup.names
        : Array.from(nameVariants(sb.name));

      const ranked = rankPortraitCandidates(entries, candidates, 5);
      const top = ranked[0];

      if (!top || top.score < minScore) {
        return {
          applied: false, mode: 'lookup', folder,
          reason: 'no_match_above_floor',
          minScore,
          candidatesSearched: candidates,
          topPick: top ?? null,
          candidates: ranked.slice(0, 5),
        };
      }

      // Detect the pair convention based on the matched file + folder layout.
      const pair = resolveAssetPair(top.entry, entries);
      const portraitUrl = pair.portrait.url ?? pair.portrait.path;
      const tokenUrl = pair.token.url ?? pair.token.path;

      try {
        if (convention === 'tokenizer') {
          // Only set img; let Tokenizer hook generate the token client-side.
          await this.applyActorPortraitOnly(actor.id, portraitUrl);
        } else if (convention === 'single' || pair.convention === 'none') {
          // Same URL on both slots.
          await this.applyActorImage(actor.id, portraitUrl, applyToToken);
        } else {
          // auto + pair found → distinct URLs for portrait and token.
          await this.applyActorPortraitAndToken(actor.id, portraitUrl, tokenUrl, applyToToken);
        }
        return {
          applied: true,
          mode: 'lookup',
          folder,
          convention,
          pairConvention: pair.convention,
          portraitUrl,
          tokenUrl: convention === 'tokenizer'
            ? null
            : (applyToToken ? (pair.convention === 'none' ? portraitUrl : tokenUrl) : null),
          matchedFile: top.entry.name,
          matchedAgainst: top.matchedAgainst,
          score: Number(top.score.toFixed(3)),
          tokenSiblingFound: pair.tokenSiblingFound,
          tokenUpdated: convention !== 'tokenizer' && applyToToken,
          candidates: ranked.slice(0, 5),
        };
      } catch (err: any) {
        return {
          applied: false, mode: 'lookup', folder, convention,
          portraitUrl, tokenUrl,
          matchedFile: top.entry.name,
          error: err?.message ?? String(err),
        };
      }
    }

    return { applied: false, reason: 'no_path_or_lookup_provided' };
  }

  /** Apply an image URL/path to an actor's portrait + token via updateActorData. */
  private async applyActorImage(
    actorId: string,
    imageUrl: string,
    applyToToken: boolean,
  ): Promise<void> {
    const updates: Record<string, any> = { img: imageUrl };
    if (applyToToken) updates['prototypeToken.texture.src'] = imageUrl;
    const r: any = await this.foundryClient.query('foundry-forge-mcp.updateActorData', {
      actorId,
      updates,
    });
    if (r?.success === false) {
      throw new Error(r?.error ?? 'updateActorData returned success=false');
    }
  }

  /** Apply distinct URLs for portrait (`img`) and token (`prototypeToken.texture.src`). */
  private async applyActorPortraitAndToken(
    actorId: string,
    portraitUrl: string,
    tokenUrl: string,
    applyToToken: boolean,
  ): Promise<void> {
    const updates: Record<string, any> = { img: portraitUrl };
    if (applyToToken) updates['prototypeToken.texture.src'] = tokenUrl;
    const r: any = await this.foundryClient.query('foundry-forge-mcp.updateActorData', {
      actorId,
      updates,
    });
    if (r?.success === false) {
      throw new Error(r?.error ?? 'updateActorData returned success=false');
    }
  }

  /**
   * Apply only the portrait (`img`), leave `prototypeToken.texture.src`
   * untouched. For the Tokenizer convention: setting actor.img triggers
   * Tokenizer's `updateActor` hook on the client, which generates a token
   * from the portrait + frame and writes prototypeToken.texture.src itself.
   */
  private async applyActorPortraitOnly(
    actorId: string,
    portraitUrl: string,
  ): Promise<void> {
    const r: any = await this.foundryClient.query('foundry-forge-mcp.updateActorData', {
      actorId,
      updates: { img: portraitUrl },
    });
    if (r?.success === false) {
      throw new Error(r?.error ?? 'updateActorData returned success=false');
    }
  }

  private async buildScratchActionItem(
    name: string,
    description: string,
    parsed?: import('../parsers/action-description.js').ParsedAction,
  ): Promise<Record<string, any>> {
    // Phase 12.0: route through the intent writer. Today's regex parser is
    // still the intent source via parsedActionToIntent; Phase 12.1 swaps in
    // an LLM call here without changing the writer.
    //
    // Reloaded encodes per-day / recharge limits in the action NAME
    // ("Tanglefoot (1/day)"). Strip the suffix and use the bare stem as the
    // item name so the sheet renders a recharge counter next to "Tanglefoot"
    // — and pass the marker as usage so dnd5e's `system.uses` carries it.
    // Marker (from name) wins over parsed.usage (from description).
    const { stem, marker } = stripUsageSuffix(name);
    const finalName = stem || name;
    const usage = marker ?? parsed?.usage;
    const intent = parsedActionToIntent({ name: finalName, description, usage, parsed });
    // Phase 9: icon resolution stays async on the call-site side — writer
    // is sync. Call resolveFeatIcon with parsed (combat-shape + name
    // keyword chain) and pass the resolved URL into the writer.
    const img = await resolveFeatIcon(finalName, parsed);
    return writeScratchItem(intent, { img });
  }

  /**
   * Phase 12.1 — scratch-build a feat item directly from an ActionIntent.
   * Bypasses the regex parser entirely. Used when the orchestrating Claude
   * session emits intents via create-actor's `actions_intent` input mode,
   * typically for prose variants the parser would misread.
   *
   * Mirrors buildScratchActionItem's flow but skips the parsed-to-intent
   * adapter step. Synthesizes the minimum ParsedAction shape resolveFeatIcon
   * needs (it checks parsed.save / parsed.attackBonus / parsed.attackType /
   * parsed.damage to pick a themed icon).
   */
  private async buildScratchItemFromIntent(intent: ActionIntent): Promise<Record<string, any>> {
    const { stem } = stripUsageSuffix(intent.name);
    const finalName = stem || intent.name;
    // Synthesize the minimum ParsedAction shape resolveFeatIcon needs.
    const iconShape: Partial<import('../parsers/action-description.js').ParsedAction> = {
      damage: intent.activities.flatMap(a => a.damage?.parts ?? []),
    };
    for (const activity of intent.activities) {
      if (activity.kind === 'save' && activity.save) {
        iconShape.save = { ability: activity.save.ability, dc: activity.save.dc };
      }
      if (activity.kind === 'attack' && activity.attack) {
        iconShape.attackBonus = activity.attack.bonus;
        if (activity.attack.attackType) iconShape.attackType = activity.attack.attackType;
      }
    }
    const img = await resolveFeatIcon(
      finalName,
      iconShape as import('../parsers/action-description.js').ParsedAction,
    );
    // The intent's name may carry the usage suffix Claude included for
    // matching; strip it for the actual feat item name so the sheet renders
    // "Tanglefoot" rather than "Tanglefoot (1/Day)".
    const finalIntent: ActionIntent = { ...intent, name: finalName };
    return writeScratchItem(finalIntent, { img });
  }

  /**
   * Phase 3b extension. Re-fetch actor items (post all additions, so flags on
   * freshly-added items participate in the keep-set) and remove compendium-base
   * feats absent from Reloaded. Best-effort — failures land in the response,
   * never raised. Default-off via `prune_base_items` arg.
   */
  private async runBaseItemPrune(
    actorId: string,
    sb: ReloadedStatblock,
    reloadedActionNames: string[],
  ): Promise<{
    enabled: boolean;
    pruned: Array<{ id: string; name: string; reason: string }>;
    kept: Array<{ id: string; name: string; reason: string }>;
    candidatesOverCap: Array<{ id: string; name: string; reason: string }>;
    error?: string;
  }> {
    try {
      const actorFull: any = await this.foundryClient.query('foundry-forge-mcp.getCharacterInfo', {
        characterName: actorId,
      });
      const items: any[] = actorFull?.items ?? [];
      const reloadedNames = [
        ...sb.traits.map(t => t.name),
        ...reloadedActionNames,
      ];
      const { decisions, toPrune, cappedOver } = selectPruneCandidates(items, reloadedNames);

      let removedIds: string[] = [];
      if (toPrune.length > 0) {
        const r: any = await this.foundryClient.query('foundry-forge-mcp.removeActorItems', {
          actorId,
          itemIds: toPrune.map(p => p.id),
        });
        removedIds = Array.isArray(r?.removed) ? r.removed.map(String) : [];
        if (r?.success === false) {
          this.logger.warn(`prune removal returned success=false`, { error: r?.error });
        }
      }

      const removedSet = new Set(removedIds);
      const pruned = toPrune
        .filter(p => removedSet.has(p.id))
        .map(p => ({ id: p.id, name: p.name, reason: p.reason }));
      // Decisions that didn't actually delete (network failure, missing on
      // server) get reported as "candidatesOverCap" too — caller can investigate.
      const failedToPrune = toPrune
        .filter(p => !removedSet.has(p.id))
        .map(p => ({ id: p.id, name: p.name, reason: `attempted but not removed (${p.reason})` }));
      const kept = decisions
        .filter(d => d.decision === 'keep')
        .map(d => ({ id: d.id, name: d.name, reason: d.reason }));

      return {
        enabled: true,
        pruned,
        kept,
        candidatesOverCap: cappedOver
          .map(c => ({ id: c.id, name: c.name, reason: c.reason }))
          .concat(failedToPrune),
      };
    } catch (err: any) {
      return {
        enabled: true,
        pruned: [],
        kept: [],
        candidatesOverCap: [],
        error: err?.message ?? String(err),
      };
    }
  }

  /** Resolve input to one markdown chunk containing a statblock div. */
  private async resolveSource(input: {
    reloaded_source?: string | undefined;
    file_path?: string | undefined;
    creature_name?: string | undefined;
  }): Promise<string> {
    if (input.reloaded_source) return input.reloaded_source;
    if (!input.file_path || !input.creature_name) {
      throw new Error('Missing source input (should be caught by schema, defense in depth)');
    }
    const content = await readFile(input.file_path, 'utf8');
    return extractStatblockSection(content, input.creature_name, input.file_path);
  }

  /** Look up a compendium actor by name. Falls back through common Reloaded name patterns. */
  private async searchForCompendiumBase(name: string): Promise<CompendiumBase | null> {
    const candidates = Array.from(nameVariants(name));
    this.logger.debug('Searching compendium for base', { name, candidates });

    for (const candidate of candidates) {
      const result: any = await this.foundryClient.query('foundry-forge-mcp.searchCompendium', {
        query: candidate,
        packType: 'Actor',
      });
      const hits = extractSearchHits(result);
      if (hits.length === 0) continue;
      // Prefer exact case-insensitive match
      const exact = hits.find((h: any) => (h.name ?? '').toLowerCase() === candidate.toLowerCase());
      const pick = exact ?? hits[0];
      const packId = pick.packId ?? pick.pack ?? pick.packName;
      const itemId = pick.id ?? pick.itemId ?? pick._id;
      if (packId && itemId) {
        this.logger.info('Compendium base matched', { candidate, packId, itemId, name: pick.name });
        return { packId, itemId };
      }
    }
    return null;
  }

  /**
   * Apply overrides in small categorized chunks. Each chunk is its own
   * update-actor call, so a dnd5e rejection of one category (e.g. the
   * prof-bonus override) doesn't block the others. Errors are caught per
   * chunk; the caller gets back a per-chunk success report.
   */
  private async applyOverridesChunked(
    actorId: string,
    sb: ReloadedStatblock,
    input: { file_path?: string | undefined },
    intentMask: ActorIntentMask | null = null,
  ): Promise<Array<{ label: string; fields: string[]; ok: boolean; error?: string }>> {
    const flagsChunk: Record<string, any> = {};
    this.stampFlags(flagsChunk, sb, input);

    const chunks: Array<{ label: string; payload: Record<string, any> }> = [
      { label: 'core-numerics', payload: this.buildCoreNumericsChunk(sb, intentMask) },
      { label: 'saves', payload: this.buildSavesChunk(sb) },
      { label: 'prof-bonus', payload: this.buildProfBonusChunk(sb) },
      { label: 'skills', payload: this.buildSkillsChunk(sb) },
      { label: 'senses', payload: this.buildSensesChunk(sb) },
      { label: 'languages', payload: this.buildLanguagesChunk(sb) },
      { label: 'damage-condition-traits', payload: this.buildTraitsChunk(sb) },
      { label: 'flags', payload: flagsChunk },
    ].filter(c => Object.keys(c.payload).length > 0);

    const results: Array<{ label: string; fields: string[]; ok: boolean; error?: string }> = [];
    for (const { label, payload } of chunks) {
      const fields = Object.keys(payload);
      try {
        const r: any = await this.foundryClient.query('foundry-forge-mcp.updateActorData', {
          actorId,
          updates: payload,
        });
        if (r?.success === false) {
          results.push({ label, fields, ok: false, error: r?.error ?? 'update returned success=false' });
        } else {
          results.push({ label, fields, ok: true });
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.logger.warn(`chunk "${label}" failed`, { error: msg, fields });
        results.push({ label, fields, ok: false, error: msg });
      }
    }
    return results;
  }

  /**
   * Parse the actor's Spellcasting feat (if present) for "Nth level (X slots)"
   * lines and write `system.spells.spellN.{max,value,override}` so slot-aware
   * HUD modules render the level rows. Compendium NPC bases (SRD Priest, Mage,
   * Cleric, etc.) ship the slot count in feat prose only; the actor's
   * `system.spells` defaults to all-zero, so HUDs that read those fields
   * directly (Argon Combat HUD, Tidy 5e) show empty level rows even when
   * prepared spells exist.
   *
   * Returns the list of `system.spells.spellN.*` keys written, or empty
   * array when no Spellcasting feat / no parseable slots / write fails.
   * Errors are caught and logged — the build doesn't fail because one HUD
   * doesn't render correctly.
   */
  private async seedSpellSlotsFromSpellcastingFeat(
    actorId: string,
    items: Array<{ name?: string; system?: { description?: { value?: string } } }>,
  ): Promise<string[]> {
    const spellcastingFeat = items.find(
      i => String(i?.name ?? '').toLowerCase() === 'spellcasting',
    );
    if (!spellcastingFeat) return [];
    const desc = spellcastingFeat.system?.description?.value ?? '';
    if (!desc) return [];

    // Match "1st level (4 slots)", "2nd level (3 slots)", etc.
    // Tolerant: matches across HTML tags, optional plural, varying whitespace.
    const slotRegex = /(\d+)\s*(?:st|nd|rd|th)\s*level\s*\((\d+)\s*slots?\)/gi;
    const updates: Record<string, number> = {};
    let match: RegExpExecArray | null;
    while ((match = slotRegex.exec(desc)) !== null) {
      const level = parseInt(match[1], 10);
      const slots = parseInt(match[2], 10);
      if (level >= 1 && level <= 9 && slots >= 0) {
        updates[`system.spells.spell${level}.max`] = slots;
        updates[`system.spells.spell${level}.value`] = slots;
        updates[`system.spells.spell${level}.override`] = slots;
      }
    }
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    try {
      const r: any = await this.foundryClient.query('foundry-forge-mcp.updateActorData', {
        actorId,
        updates,
      });
      if (r?.success === false) {
        this.logger.warn('seedSpellSlotsFromSpellcastingFeat: update returned success=false', {
          actorId,
          error: r?.error,
        });
        return [];
      }
      return keys;
    } catch (err: any) {
      this.logger.warn('seedSpellSlotsFromSpellcastingFeat failed', {
        actorId,
        error: err?.message ?? String(err),
      });
      return [];
    }
  }

  /**
   * Add items to an actor, trying the whole batch first and falling back to
   * one-at-a-time on any failure. Observed empirically on 2026-04-21:
   * `createEmbeddedDocuments` via WebRTC hangs past our 10s query timeout for
   * batches as small as 5 items (likely per-item active-effect/derivation
   * passes cascading inside a single Foundry transaction), but the same items
   * added individually complete in milliseconds each. So the fast-path is the
   * single batched call; on failure we isolate every item so one bad entry
   * can't drop the rest.
   */
  private async addItemsWithBatchFallback(
    actorId: string,
    items: Array<Record<string, any>>,
  ): Promise<{ added: string[]; failed: Array<{ name: string; error: string }> }> {
    if (items.length === 0) return { added: [], failed: [] };

    // Fast path: everything in one call.
    try {
      const result: any = await this.foundryClient.query('foundry-forge-mcp.addActorItems', {
        actorId,
        items,
      });
      if (result?.success !== false) {
        return { added: items.map(i => String(i.name)), failed: [] };
      }
      this.logger.warn(
        `batch add-actor-items returned success=false; falling back to one-at-a-time`,
        { count: items.length, error: result?.error },
      );
    } catch (err: any) {
      this.logger.warn(
        `batch add-actor-items threw; falling back to one-at-a-time`,
        { count: items.length, error: err?.message ?? String(err) },
      );
    }

    // Fallback: issue one add per item. Each failure is isolated.
    const added: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const item of items) {
      const name = String(item.name);
      try {
        const r: any = await this.foundryClient.query('foundry-forge-mcp.addActorItems', {
          actorId,
          items: [item],
        });
        if (r?.success !== false) {
          added.push(name);
        } else {
          failed.push({ name, error: r?.error ?? 'success=false' });
        }
      } catch (err: any) {
        failed.push({ name, error: err?.message ?? String(err) });
      }
    }
    return { added, failed };
  }

  private buildCoreNumericsChunk(
    sb: ReloadedStatblock,
    mask: ActorIntentMask | null = null,
  ): Record<string, any> {
    const u: Record<string, any> = {};
    // mask is null in Mode A (real statblock parse) — write every field.
    // mask is non-null in Mode E — skip a block when the intent didn't
    // supply it, so adapter defaults (HP 1 / AC 10 / walk 0 / abilities 10)
    // don't overwrite the spawned compendium base.
    if (!mask || mask.hp) {
      u['system.attributes.hp.max'] = sb.hp.avg;
      u['system.attributes.hp.value'] = sb.hp.avg;
      if (sb.hp.formula) u['system.attributes.hp.formula'] = sb.hp.formula;
    }
    if (!mask || mask.ac) {
      u['system.attributes.ac.flat'] = sb.ac;
      u['system.attributes.ac.calc'] = 'flat';
    }
    if (!mask || mask.speed) {
      for (const [mode, value] of Object.entries(sb.speed)) {
        u[`system.attributes.movement.${mode}`] = value;
      }
    }
    if (!mask || mask.abilities) {
      for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
        u[`system.abilities.${ab}.value`] = sb.abilities[ab].score;
      }
    }
    if (sb.challengeNumeric !== null) u['system.details.cr'] = sb.challengeNumeric;
    if (sb.alignment) u['system.details.alignment'] = sb.alignment;
    return u;
  }

  private buildSavesChunk(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};
    for (const ab of Object.keys(sb.saves)) {
      if (['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(ab)) {
        u[`system.abilities.${ab}.proficient`] = 1;
      }
    }
    return u;
  }

  private buildProfBonusChunk(sb: ReloadedStatblock): Record<string, any> {
    return sb.proficiencyBonus !== null
      ? { 'system.attributes.prof': sb.proficiencyBonus }
      : {};
  }

  private buildSkillsChunk(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};
    // Reloaded statblocks sometimes omit the printed Proficiency Bonus line
    // (e.g. Volenta, Second Form). Fall back to deriving PB from CR so
    // expertise inference still fires. Final fallback is 0, which short-circuits
    // the level calc below and leaves skills at basic proficiency.
    const prof = sb.proficiencyBonus ?? derivePBFromCR(sb.challengeNumeric);
    for (const [skillName, printedMod] of Object.entries(sb.skills)) {
      const abbr = SKILL_NAME_TO_ABBR[skillName.toLowerCase()];
      if (!abbr) continue;
      const abilityKey = SKILL_TO_ABILITY[abbr];
      const abilityScore = abilityKey ? sb.abilities[abilityKey]?.score : undefined;
      // Infer proficiency level from the printed modifier:
      //   delta == prof_bonus       → expertise   (value=2)
      //   delta == ceil(prof / 2)   → half-prof   (value=0.5)
      //   else                      → basic prof  (value=1)
      // Falls back to basic when ability score / prof isn't known. Volenta's
      // Acrobatics/Stealth +10 (Dex 18, prof +3) → mod +4 + prof 3 = basic +7,
      // delta +3 = prof, so expertise. Perception +5 = Wis 14 mod +2 + prof 3,
      // delta 0, so basic.
      let level: 1 | 2 | 0.5 = 1;
      if (abilityScore !== undefined && prof > 0) {
        const abilityMod = Math.floor((abilityScore - 10) / 2);
        const baseProf = abilityMod + prof;
        const delta = printedMod - baseProf;
        if (delta === prof) level = 2;
        else if (delta === Math.ceil(prof / 2)) level = 0.5;
      }
      u[`system.skills.${abbr}.value`] = level;
      u[`system.skills.${abbr}.proficient`] = level;
    }
    return u;
  }

  private buildSensesChunk(sb: ReloadedStatblock): Record<string, any> {
    const modes = parseSenses(sb.sensesText);
    if (Object.keys(modes).length === 0) return {};
    const u: Record<string, any> = { 'system.attributes.senses.units': 'ft' };
    for (const [mode, feet] of Object.entries(modes)) {
      u[`system.attributes.senses.${mode}`] = feet;
    }
    return u;
  }

  private buildLanguagesChunk(sb: ReloadedStatblock): Record<string, any> {
    return sb.languages ? { 'system.traits.languages.custom': sb.languages } : {};
  }

  private buildTraitsChunk(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};
    assignTraitList(u, 'di', sb.damageImmunities, DAMAGE_TYPES);
    assignTraitList(u, 'dr', sb.damageResistances, DAMAGE_TYPES);
    assignTraitList(u, 'dv', sb.damageVulnerabilities, DAMAGE_TYPES);
    assignTraitList(u, 'ci', sb.conditionImmunities, CONDITION_TYPES);
    return u;
  }

  /** Legacy one-shot version; retained for external callers. */
  private buildOverrides(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};

    // === Core numerics (Phase 2 MVP) ===

    u['system.attributes.hp.max'] = sb.hp.avg;
    u['system.attributes.hp.value'] = sb.hp.avg;
    if (sb.hp.formula) u['system.attributes.hp.formula'] = sb.hp.formula;

    u['system.attributes.ac.flat'] = sb.ac;
    u['system.attributes.ac.calc'] = 'flat';

    for (const [mode, value] of Object.entries(sb.speed)) {
      u[`system.attributes.movement.${mode}`] = value;
    }

    for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
      u[`system.abilities.${ab}.value`] = sb.abilities[ab].score;
    }

    if (sb.challengeNumeric !== null) {
      u['system.details.cr'] = sb.challengeNumeric;
    }

    for (const ab of Object.keys(sb.saves)) {
      if (['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(ab)) {
        u[`system.abilities.${ab}.proficient`] = 1;
      }
    }

    // === Advanced fields (Phase 3a-B) ===

    // Proficiency bonus override — Reloaded sometimes prints a PB that
    // doesn't match dnd5e's CR-derived default (Wight Commander CR 10 derives
    // +4; Reloaded prints +3). Setting this field pins the actor's bonus.
    if (sb.proficiencyBonus !== null) {
      u['system.attributes.prof'] = sb.proficiencyBonus;
    }

    // Skills — map full name to dnd5e abbreviation, mark proficient. Expertise
    // detection (bonus = mod + 2*prof) is deferred; Reloaded doesn't mark it
    // explicitly and most NPCs don't use it.
    for (const [skillName, _bonus] of Object.entries(sb.skills)) {
      const abbr = SKILL_NAME_TO_ABBR[skillName.toLowerCase()];
      if (abbr) u[`system.skills.${abbr}.proficient`] = 1;
    }

    // Senses — parse darkvision/blindsight/tremorsense/truesight feet out of
    // the sensesText. Passive Perception is intentionally NOT set; dnd5e
    // derives it from WIS + Perception prof + prof bonus.
    const senseModes = parseSenses(sb.sensesText);
    if (Object.keys(senseModes).length > 0) {
      u['system.attributes.senses.units'] = 'ft';
      for (const [mode, feet] of Object.entries(senseModes)) {
        u[`system.attributes.senses.${mode}`] = feet;
      }
    }

    // Languages — push the raw Reloaded text into `.custom` (semicolon-
    // delimited; dnd5e renders it alongside the code list). We don't try
    // to map "Abyssal, Common, Draconic" to dnd5e's language codes for
    // MVP — future improvement.
    if (sb.languages) {
      u['system.traits.languages.custom'] = sb.languages;
    }

    // Damage / condition trait lists. Our parseTraitList recognizes canonical
    // dnd5e damage types and conditions; unrecognized tokens (e.g. the
    // "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks that
    // aren't Silvered" clause on Wight Commander) go into `.custom`.
    assignTraitList(u, 'di', sb.damageImmunities, DAMAGE_TYPES);
    assignTraitList(u, 'dr', sb.damageResistances, DAMAGE_TYPES);
    assignTraitList(u, 'dv', sb.damageVulnerabilities, DAMAGE_TYPES);
    assignTraitList(u, 'ci', sb.conditionImmunities, CONDITION_TYPES);

    return u;
  }

  private stampFlags(
    u: Record<string, any>,
    sb: ReloadedStatblock,
    input: { file_path?: string | undefined },
  ): void {
    u['flags.foundry-forge-mcp.source'] = 'reloaded-hybrid';
    u['flags.foundry-forge-mcp.reloadedName'] = sb.name;
    if (input.file_path) u['flags.foundry-forge-mcp.reloadedPath'] = input.file_path;
    u['flags.foundry-forge-mcp.createdAt'] = new Date().toISOString();
  }
}

// ----- helpers --------------------------------------------------------------

/** Yield name variants to search for in a compendium: exact, pre-comma stem, role-stripped stem. */
// ----- Phase 5: portrait fuzzy-matching ------------------------------------

export interface PortraitMatch {
  entry: ForgeAssetEntry;
  /** Which candidate name matched best (e.g. "Volenta" vs "Volenta, First Form"). */
  matchedAgainst: string;
  /** Score in [0..1]. Exact normalized match = 1.0; substring = 0.85; token Jaccard otherwise. */
  score: number;
}

/**
 * Rank Forge asset entries against a list of candidate creature-name variants.
 * Pure function, exported for tests. Returns best-first up to `limit`.
 *
 * Scoring is intentionally permissive in the substring branch (0.85) so tokens
 * named "Volenta_First_Form.webp" still beat purely-token-overlapped neighbors
 * when the full creature name is "Volenta, First Form". Below 0.5 the resolver
 * returns candidates without applying — caller decides.
 */
export function rankPortraitCandidates(
  entries: ForgeAssetEntry[],
  candidates: string[],
  limit: number,
): PortraitMatch[] {
  const ranked: PortraitMatch[] = [];
  for (const entry of entries) {
    // Strip extension off the basename for the match. Multi-dot names like
    // "Volenta.First.webp" lose only the trailing extension.
    const stem = entry.name.replace(/\.[^.]+$/, '');
    let bestForEntry: { score: number; matchedAgainst: string } | null = null;
    for (const cand of candidates) {
      const score = portraitNameScore(cand, stem);
      if (!bestForEntry || score > bestForEntry.score) {
        bestForEntry = { score, matchedAgainst: cand };
      }
    }
    if (bestForEntry && bestForEntry.score > 0) {
      ranked.push({ entry, matchedAgainst: bestForEntry.matchedAgainst, score: bestForEntry.score });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

/**
 * Score how well `candidate` (stripped filename like "Volenta_First_Form")
 * matches `query` (a creature-name variant like "Volenta, First Form"). Both
 * are normalized (lowercase, non-alphanumerics → spaces) before comparison.
 *
 * - 1.0 — normalized exact match
 * - 0.85 — one is a normalized substring of the other (length-disparity-tolerant)
 * - 0..1 — Jaccard token overlap (tokens of length ≥ 3, lowercased)
 *
 * The substring branch is what catches "Volenta" → "Volenta_First_Form" or
 * "Volenta, First Form" → "Volenta_First_Form" — both score 0.85 here, well
 * above the 0.5 auto-apply floor.
 */
export function portraitNameScore(query: string, candidate: string): number {
  const normQ = normalizePortraitName(query);
  const normC = normalizePortraitName(candidate);
  if (!normQ || !normC) return 0;
  if (normQ === normC) return 1.0;
  // Compact (no-space) substring check — "volentafirstform" includes "volenta"
  // and vice-versa.
  const compactQ = normQ.replace(/\s+/g, '');
  const compactC = normC.replace(/\s+/g, '');
  if (compactC.includes(compactQ) || compactQ.includes(compactC)) return 0.85;

  const qTokens = new Set(normQ.split(/\s+/).filter(t => t.length >= 3));
  const cTokens = new Set(normC.split(/\s+/).filter(t => t.length >= 3));
  if (qTokens.size === 0 || cTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of qTokens) if (cTokens.has(t)) overlap++;
  return overlap / Math.max(qTokens.size, cTokens.size);
}

function normalizePortraitName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Beneos cos_tokens convention: each NPC ships as a pair —
 *   `<stem>.webp`         (portrait, larger image)
 *   `<stem>_token.webp`   (token, round/square ready for the canvas)
 *
 * Given the resolver's top match and the full file list, return the right
 * URL for each slot. If the matched filename is the `_token` variant, find
 * its non-token sibling for `img`. If the matched filename is the portrait
 * variant, find its `_token` sibling for `prototypeToken.texture.src`. If
 * no sibling exists, both fields fall back to the matched URL (correct
 * behavior for libraries that don't follow the pair convention).
 *
 * Pure function — exported for tests.
 */
export type PairConventionMatched = 'same-folder-suffix' | 'sibling-folder' | 'none';

/**
 * Resolve a portrait/token pair across the four conventions observed in
 * Ben's libraries (probed live 2026-04-26):
 *
 *   1. Same-folder suffix `_token` — Beneos cos_tokens (valenta_popofsky.webp +
 *      valenta_popofsky_token.webp).
 *   2. Same-folder suffix `.Avatar` / `.Token` — Tokenizer pc-images
 *      (aezael.Avatar.webp + aezael.Token.webp).
 *   3. Sibling-folder pair — My Avatars/NPCs/Avatars/Doru.png +
 *      My Avatars/NPCs/Tokens/Doru.png; or Strahd's Minions/Portrait/...
 *      and Strahd's Minions/Token/... — same filename, different folder.
 *   4. No sibling — single file. Caller decides single vs tokenizer mode.
 *
 * Pure function. Returns the resolved pair plus which convention won (for
 * diagnostics surfaced in the tool response).
 */
export function resolveAssetPair(
  matched: ForgeAssetEntry,
  allEntries: ForgeAssetEntry[],
): {
  portrait: ForgeAssetEntry;
  token: ForgeAssetEntry;
  tokenSiblingFound: boolean;
  convention: PairConventionMatched;
} {
  const suffixMatch = trySuffixPair(matched, allEntries);
  if (suffixMatch) {
    return { ...suffixMatch, tokenSiblingFound: true, convention: 'same-folder-suffix' };
  }

  const siblingMatch = trySiblingFolderPair(matched, allEntries);
  if (siblingMatch) {
    return { ...siblingMatch, tokenSiblingFound: true, convention: 'sibling-folder' };
  }

  return { portrait: matched, token: matched, tokenSiblingFound: false, convention: 'none' };
}

/** Same-folder suffix pair: `_token` (Beneos) or `.Token`/`.Avatar` (Tokenizer). */
function trySuffixPair(
  matched: ForgeAssetEntry,
  allEntries: ForgeAssetEntry[],
): { portrait: ForgeAssetEntry; token: ForgeAssetEntry } | null {
  const stem = matched.name.replace(/\.[^.]+$/, '');
  const ext = matched.name.match(/\.[^.]+$/)?.[0] ?? '';
  const matchedDir = directoryOf(matched.path);

  // Tokenizer-style `.Token` / `.Avatar` first since it's more specific.
  const tokenizerSuffix = stem.match(/\.(Token|Avatar)$/i);
  if (tokenizerSuffix) {
    const flip = tokenizerSuffix[1].toLowerCase() === 'token' ? 'Avatar' : 'Token';
    const otherStem = stem.replace(/\.(Token|Avatar)$/i, `.${flip}`);
    const otherName = `${otherStem}${ext}`;
    const other = allEntries.find(e =>
      directoryOf(e.path) === matchedDir &&
      e.name.toLowerCase() === otherName.toLowerCase());
    if (other) {
      return tokenizerSuffix[1].toLowerCase() === 'token'
        ? { portrait: other, token: matched }
        : { portrait: matched, token: other };
    }
  }

  // Beneos `_token` suffix (only the token side carries the suffix).
  const isToken = /_token$/i.test(stem);
  if (isToken) {
    const portraitName = `${stem.replace(/_token$/i, '')}${ext}`;
    const portrait = allEntries.find(e =>
      directoryOf(e.path) === matchedDir &&
      e.name.toLowerCase() === portraitName.toLowerCase());
    if (portrait) return { portrait, token: matched };
  } else {
    const tokenName = `${stem}_token${ext}`;
    const token = allEntries.find(e =>
      directoryOf(e.path) === matchedDir &&
      e.name.toLowerCase() === tokenName.toLowerCase());
    if (token) return { portrait: matched, token };
  }

  return null;
}

/**
 * Sibling-folder pair: portraits + tokens in parallel folders sharing a parent.
 * Recognized pairs (case-insensitive): Avatars/Tokens, Avatar/Token,
 * Portraits/Tokens, Portrait/Token. Filenames must match across the pair.
 */
function trySiblingFolderPair(
  matched: ForgeAssetEntry,
  allEntries: ForgeAssetEntry[],
): { portrait: ForgeAssetEntry; token: ForgeAssetEntry } | null {
  const matchedDir = directoryOf(matched.path);
  const matchedDirName = matchedDir.split('/').pop() ?? '';
  const parentDir = matchedDir.slice(0, matchedDir.length - matchedDirName.length).replace(/\/$/, '');

  const SIBLING_PAIRS: Array<[string, string]> = [
    ['avatars', 'tokens'], ['avatar', 'token'],
    ['portraits', 'tokens'], ['portrait', 'token'],
  ];

  for (const [a, b] of SIBLING_PAIRS) {
    const lc = matchedDirName.toLowerCase();
    let siblingDirName: string | null = null;
    let matchedIsPortrait = false;
    if (lc === a) { siblingDirName = b; matchedIsPortrait = true; }
    else if (lc === b) { siblingDirName = a; matchedIsPortrait = false; }
    if (!siblingDirName) continue;

    // Preserve the case style of the matched dir for the sibling lookup.
    const cased = matchedDirName === matchedDirName.toLowerCase()
      ? siblingDirName
      : siblingDirName.charAt(0).toUpperCase() + siblingDirName.slice(1);

    const candidatePrefix = parentDir ? `${parentDir}/${cased}/` : `${cased}/`;
    const candidatePrefixLower = candidatePrefix.toLowerCase();

    const sibling = allEntries.find(e =>
      e.path.toLowerCase().startsWith(candidatePrefixLower) &&
      e.name.toLowerCase() === matched.name.toLowerCase());
    if (sibling) {
      return matchedIsPortrait
        ? { portrait: matched, token: sibling }
        : { portrait: sibling, token: matched };
    }
  }
  return null;
}

function directoryOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/** @deprecated Use resolveAssetPair. Kept for backward-compat tests. */
export function resolveBeneosPair(
  matched: ForgeAssetEntry,
  allEntries: ForgeAssetEntry[],
): { portrait: ForgeAssetEntry; token: ForgeAssetEntry; tokenSiblingFound: boolean } {
  const r = resolveAssetPair(matched, allEntries);
  return { portrait: r.portrait, token: r.token, tokenSiblingFound: r.tokenSiblingFound };
}

function* nameVariants(name: string): Generator<string> {
  yield name;
  const preComma = name.split(',')[0].trim();
  if (preComma && preComma !== name) yield preComma;

  // Strip trailing role/title tokens: "Wight Commander" → "Wight"
  const roleStripped = preComma.replace(
    /\s+(Commander|Captain|Lord|Lady|Knight|Warrior|Mage|Priest|Priestess|Lieutenant|King|Queen|Hero|Chief|Boss|Leader|Champion|Slayer|Hunter)\s*$/i,
    '',
  ).trim();
  if (roleStripped && roleStripped !== preComma) yield roleStripped;
}

/** searchCompendium response shape varies; normalize to an array of hits. */
function extractSearchHits(result: any): any[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.results)) return result.results;
  if (Array.isArray(result.response)) return result.response;
  // The dnd5e search returns objects keyed by pack; flatten.
  if (typeof result === 'object') {
    const nested = Object.values(result).filter(v => Array.isArray(v)).flat();
    if (nested.length) return nested;
  }
  return [];
}

/**
 * Extract the markdown chunk under a heading. Tries (in order):
 *   1. Exact match: `### <heading>`
 *   2. Numbered prefix: `### N. <heading>` / `### Na. <heading>` (e.g.
 *      Father Lucian appears under `### 2. Father Lucian`)
 *   3. Substring case-insensitive: any `### ...<heading>...` heading line
 *
 * Stops at the next heading of any level. Used both for statblock-div sections
 * and prose-only sections (Lucian, Wensencia's steed, etc.).
 */
export function extractStatblockSection(
  fileContent: string,
  heading: string,
  sourcePath?: string,
): string {
  const lines = fileContent.split(/\r?\n/);
  const target = heading.toLowerCase().trim();

  let startIdx = lines.findIndex(l => l.trim() === `### ${heading}`);
  if (startIdx < 0) {
    // Numbered prefix — `### 2. Father Lucian`, `### D4c. Volenta's Trap`.
    const prefixed = new RegExp(
      `^###\\s+[\\dA-Za-z]+\\.\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    );
    startIdx = lines.findIndex(l => prefixed.test(l));
  }
  if (startIdx < 0) {
    // Substring fallback (case-insensitive). Picks the FIRST `### ...<target>...`
    // — caller should pass enough of the name to disambiguate.
    startIdx = lines.findIndex(l => {
      const m = l.match(/^###\s+(.+?)\s*$/);
      return !!m && m[1].toLowerCase().includes(target);
    });
  }
  if (startIdx < 0) {
    const where = sourcePath ? ` in ${sourcePath}` : '';
    throw new Error(`No "### ..." heading matching "${heading}" found${where}`);
  }

  const relEnd = lines.slice(startIdx + 1).findIndex(l => /^#{1,3}\s/.test(l));
  const end = relEnd < 0 ? lines.length : startIdx + 1 + relEnd;
  return lines.slice(startIdx, end).join('\n');
}

// ----- dnd5e system maps -----------------------------------------------------

/**
 * Derive proficiency bonus from CR per the dnd5e SRD table
 * (CR 0-4 → +2, 5-8 → +3, 9-12 → +4, 13-16 → +5, 17-20 → +6, 21-24 → +7,
 * 25-28 → +8, 29-30 → +9). Used as a fallback when Reloaded omits the
 * printed Proficiency Bonus line. Returns 0 when CR is null so callers can
 * detect "no info available" and skip downstream PB-dependent inference.
 */
export function derivePBFromCR(cr: number | null): number {
  if (cr === null) return 0;
  return Math.max(2, Math.ceil(cr / 4) + 1);
}

const SKILL_NAME_TO_ABBR: Record<string, string> = {
  acrobatics: 'acr',
  'animal handling': 'ani',
  arcana: 'arc',
  athletics: 'ath',
  deception: 'dec',
  history: 'his',
  insight: 'ins',
  intimidation: 'itm',
  investigation: 'inv',
  medicine: 'med',
  nature: 'nat',
  perception: 'prc',
  performance: 'prf',
  persuasion: 'per',
  religion: 'rel',
  'sleight of hand': 'slt',
  stealth: 'ste',
  survival: 'sur',
};

// Skill-abbr → governing ability (dnd5e 5e default mapping). Used by the
// skills chunk to compute the basic-prof baseline modifier so we can infer
// expertise / half-prof from the printed Reloaded modifier.
const SKILL_TO_ABILITY: Record<string, 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'> = {
  acr: 'dex', ani: 'wis', arc: 'int', ath: 'str', dec: 'cha', his: 'int',
  ins: 'wis', itm: 'cha', inv: 'int', med: 'wis', nat: 'int', prc: 'wis',
  prf: 'cha', per: 'cha', rel: 'int', slt: 'dex', ste: 'dex', sur: 'wis',
};

const SIZE_CODE_TO_WORD_LOCAL: Record<string, string> = {
  tiny: 'tiny', sm: 'small', med: 'medium', lg: 'large', huge: 'huge', grg: 'gargantuan',
};

const DAMAGE_TYPES = new Set([
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
]);

const CONDITION_TYPES = new Set([
  'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
  'prone', 'restrained', 'stunned', 'unconscious',
]);

/**
 * Split a Reloaded "Damage Resistances" / "Condition Immunities" / etc string
 * into recognized tokens (pushed to `.value`) and unrecognized trailing prose
 * (pushed to `.custom`). Handles the common "necrotic; bludgeoning, piercing,
 * and slashing from nonmagical attacks that aren't silvered" pattern — the
 * semicolon-prefixed clause stays as custom text.
 */
function assignTraitList(
  updates: Record<string, any>,
  field: 'di' | 'dr' | 'dv' | 'ci',
  raw: string | null,
  valid: Set<string>,
): void {
  if (!raw) return;
  const recognized: string[] = [];
  const customParts: string[] = [];

  // Split on semicolons FIRST (top-level grouping), then commas/and within.
  for (const segment of raw.split(';').map(s => s.trim()).filter(Boolean)) {
    const tokens = segment
      .replace(/\band\b/gi, ',')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);
    const allRecognized = tokens.every(t => valid.has(t));
    if (allRecognized) {
      recognized.push(...tokens);
    } else {
      // Any unrecognized token in this segment → treat whole segment as custom
      // text so clauses stay readable (e.g. "bludgeoning, piercing, and
      // slashing from nonmagical attacks").
      customParts.push(segment);
    }
  }

  if (recognized.length > 0) updates[`system.traits.${field}.value`] = recognized;
  if (customParts.length > 0) updates[`system.traits.${field}.custom`] = customParts.join('; ');
}

/** Parse "Darkvision 60 ft., passive Perception 14" → { darkvision: 60 }. */
function parseSenses(text: string): Record<string, number> {
  if (!text) return {};
  const out: Record<string, number> = {};
  // Only these keys exist on dnd5e's actor.system.attributes.senses
  const modes = ['darkvision', 'blindsight', 'tremorsense', 'truesight'] as const;
  for (const mode of modes) {
    const m = text.match(new RegExp(`\\b${mode}\\s+(\\d+)\\s*ft\\.?`, 'i'));
    if (m) out[mode] = parseInt(m[1], 10);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ----- Action → activity patching (Phase 3a-C) -------------------------------

/**
 * Build an update payload for one item targeting ALL of its activities that
 * have a corresponding field in the parsed Reloaded action. An item with both
 * an `attack` and a `save` activity (e.g. Life Drain) gets both branches
 * patched in a single update.
 */
export function buildItemActivityUpdate(
  itemId: string,
  activities: Record<string, any>,
  parsed: import('../parsers/action-description.js').ParsedAction,
): Record<string, any> {
  // Phase 12.0: route through the intent writer. Copy-patch path doesn't
  // care about item name / description (those don't change), so the
  // adapter is fed empty placeholders.
  const intent = parsedActionToIntent({ name: '', description: '', parsed });
  return writeActivityUpdate(itemId, activities, intent);
}

// ----- Phase 10B: trait template registry ----------------------------------

/**
 * Phase 10B — registry of known monster-trait templates. When create-actor
 * adds a Reloaded-only trait whose name matches a registered template, the
 * trait lands with the full Midi/DAE effect shape (key + value + mode +
 * priority) instead of a description-only feat. Reloaded creatures with
 * traits like Pack Tactics or Sunlight Sensitivity get correct table-side
 * automation out of the box.
 *
 * Why this is separate from the audit framework (Phase 11): audit READS,
 * templates BUILD. They're complementary — a future audit rule can lint
 * "trait name matches a registered template, but item shape doesn't" to
 * surface stale DDB-imported actors that the registry could fix.
 *
 * Registry grows with new templates as we encounter creatures that need
 * them. Initial set covers the Volenta-relevant + most-broken-DDB cases.
 */
export interface TraitTemplate {
  /** Canonical template name (used as the item name + matched against trait names). */
  name: string;
  /** Lower-case names that should resolve to this template (Reloaded variants). */
  aliases: string[];
  /**
   * Build the trait's item document patches. Returns the partial item doc
   * additions to merge on top of the default {description, source, type:
   * monster, img}. Typically: { effects: [<effectDoc>], flags?, system? }.
   */
  build(name: string, description: string): Record<string, any>;
}

// Phase 12.0: each entry's build() routes through writeTrait. The effect
// shape (changes, flags, statuses, transfer mode, img) is now owned by the
// intent writer's TraitIntentKind branches — keep this registry as the
// name/alias resolver only.
export const TRAIT_TEMPLATES: TraitTemplate[] = [
  {
    name: 'Pack Tactics',
    aliases: ['pack tactics'],
    build: (name, description) => writeTrait({ kind: 'pack-tactics', name, description }),
  },
  {
    name: 'Sunlight Sensitivity',
    aliases: ['sunlight sensitivity'],
    build: (name, description) => writeTrait({ kind: 'sunlight-sensitivity', name, description }),
  },
  {
    // Distinct from Sunlight Sensitivity: vampire-style hypersensitivity
    // adds a 20-radiant-damage-per-turn OverTime tick on top of the
    // disadvantage flags. Bundling them under one alias mis-shaped Volenta
    // (2026-05-02) — she got the disadvantage but no damage tick.
    name: 'Sunlight Hypersensitivity',
    aliases: ['sunlight hypersensitivity'],
    build: (name, description) => writeTrait({ kind: 'sunlight-hypersensitivity', name, description }),
  },
  {
    // Vampire / troll / similar self-healing. Heal amount auto-parsed from
    // the trait description ("regains X hit points") with default 10.
    // Includes condition=@hp.value<@hp.max so the OverTime no-ops at full HP.
    name: 'Regeneration',
    aliases: ['regeneration'],
    build: (name, description) => writeTrait({ kind: 'regeneration', name, description }),
  },
  {
    // Advantage on saves vs spells/magical effects. Always-on, no GM toggle.
    name: 'Magic Resistance',
    aliases: ['magic resistance'],
    build: (name, description) => writeTrait({ kind: 'magic-resistance', name, description }),
  },
];

/**
 * Resolve a trait name to a registered template. Case-insensitive; checks
 * canonical name + aliases. Returns null if no template matches — caller
 * falls back to building a description-only feat.
 */
export function resolveTraitTemplate(traitName: string): TraitTemplate | null {
  const lc = traitName.toLowerCase().trim();
  for (const tpl of TRAIT_TEMPLATES) {
    if (tpl.name.toLowerCase() === lc) return tpl;
    if (tpl.aliases.includes(lc)) return tpl;
  }
  return null;
}

/**
 * Build a Foundry ActiveEffect document for a save-fail condition application.
 * Mirrors the DDB-imported Wolf Bite "Status: Prone" effect shape: transfer
 * disabled (so the effect only fires when the activity uses it, not passively
 * on item add), DAE stackable=noneNameOnly (one instance per condition),
 * Midi forceCEOff (use Foundry's native condition system, not Convenient
 * Effects which can shadow the status).
 *
 * Caller links this effect from the save activity via `effects: [{_id, ...}]`
 * so Midi's save-resolution flow finds it on a failed save.
 */
export function buildConditionEffect(
  condition: import('../parsers/action-description.js').ParsedCondition,
): Record<string, any> {
  // Phase 12.0: route through the intent writer. ParsedCondition is
  // structurally identical to ConditionIntent (type + optional duration +
  // optional repeatSave) — all fields pass through unchanged.
  const intent: ConditionIntent = { type: condition.type };
  if (condition.duration) intent.duration = condition.duration;
  if (condition.repeatSave) intent.repeatSave = condition.repeatSave;
  return writeConditionEffect(intent);
}

/**
 * Phase 10A.7 — build the dnd5e activity `target` block from a parsed action's
 * targetShape. Returns null when there's nothing meaningful to write (no shape
 * + no inferable default).
 *
 * Shape:
 *   target: {
 *     template?: { type: 'circle'|'cone'|'line'|'cube'|'sphere'|'cylinder', size, units, width? }
 *     affects?: { type: 'creature'|'enemy'|'ally'|..., count?, choice? }
 *     prompt: true
 *   }
 *
 * Defaults applied:
 * - Save-only saves with no template + no parsed affects: leave undefined so
 *   dnd5e schema defaults kick in (the GUI "Type" field stays at the system
 *   default, which is acceptable — manual targeting works at the table).
 * - Attack activities: parsed.targetShape.affects already defaults to
 *   { type: 'creature', count: 1 } in the parser. We mirror that here.
 */
export function buildActivityTarget(
  parsed: import('../parsers/action-description.js').ParsedAction,
): Record<string, any> | null {
  const shape = parsed.targetShape;
  if (!shape || (!shape.template && !shape.affects)) return null;

  const target: Record<string, any> = { prompt: true };

  if (shape.template) {
    target.template = {
      type: shape.template.shape,
      size: shape.template.size,
      units: 'ft',
      ...(shape.template.width !== undefined ? { width: shape.template.width } : {}),
    };
  }

  if (shape.affects) {
    // Keep count + choice on the activity even when a template is present.
    // Reloaded's "up to two creatures within 5 feet of one another" is a real
    // mechanical cap — the player should select WHICH two creatures inside
    // the placed template are affected. dnd5e activity GUI exposes this as
    // "select N targets" in the post-template confirm flow.
    //
    // UX prompt order (template-place first, then target-pick) is controlled
    // by Midi-QOL global settings, NOT activity-level fields:
    //   Settings → Module Settings → Midi-QOL → Workflow Settings:
    //     "Auto Target on Template" = "Always" (auto-fills targets from area)
    //     "Place Measured Templates First" / equivalent ordering setting
    //
    // If the GM gets a manual-target picker BEFORE the template prompt, that
    // flow is from Midi defaulting to manual targeting; flipping the global
    // setting fixes it for every AOE activity, not just ours.
    target.affects = {
      type: shape.affects.type,
      ...(shape.affects.count !== undefined ? { count: shape.affects.count } : {}),
      ...(shape.affects.choice !== undefined ? { choice: shape.affects.choice } : {}),
    };
  }

  return target;
}

// ----- Phase 8: usage-suffix normalization ---------------------------------

/**
 * Strip a trailing usage parenthetical like "(1/Day)", "(3/Day)",
 * "(Recharge 5-6)", "(Short Rest)" from an action name and return both the
 * bare stem and the structured usage marker. Returns `marker: null` when the
 * name has no recognizable usage suffix.
 *
 * Reloaded encodes per-day / recharge limits in the action NAME ("Tanglefoot
 * (1/day)"). dnd5e 2024 / 5.x stores the same data on the item via
 * `system.uses.max` + `system.uses.recovery`. Phase 8 peels the suffix out so
 * built actors land with bare item names + mechanical recharge counters,
 * matching dnd5e's native UI and avoiding name-collisions when a compendium
 * base already has the bare name (e.g. world's "Tanglefoot" base versus
 * Reloaded's "Tanglefoot (1/day)" — same thing, same item).
 */
export function stripUsageSuffix(
  name: string,
): { stem: string; marker: ParsedAction['usage'] | null } {
  if (!name) return { stem: name, marker: null };
  const re = /\s*\(\s*(?:(\d+)\s*\/\s*(day|short\s*rest|long\s*rest|turn)|recharge\s+(\d+)(?:\s*[-–]\s*(\d+))?)\s*\)\s*$/i;
  const m = name.match(re);
  if (!m) return { stem: name.trim(), marker: null };
  const stem = name.slice(0, name.length - m[0].length).trim();
  if (m[1]) {
    const count = parseInt(m[1], 10);
    const periodLower = m[2].toLowerCase().replace(/\s+/g, '-');
    const period =
      periodLower === 'day' ? 'day'
      : periodLower === 'short-rest' ? 'short-rest'
      : periodLower === 'long-rest' ? 'long-rest'
      : 'turn';
    return { stem, marker: { count, period } };
  }
  if (m[3]) {
    const lo = parseInt(m[3], 10);
    const hi = m[4] ? parseInt(m[4], 10) : lo;
    return { stem, marker: { recharge: [lo, hi] } };
  }
  return { stem, marker: null };
}

/**
 * Convert a ParsedAction['usage'] marker into the dnd5e 5.x `system.uses` shape.
 * Returns `null` when the marker is null/undefined so callers can skip the
 * write entirely instead of clobbering with empty values.
 */
export function buildUsesPayload(marker: ParsedAction['usage'] | null | undefined): Record<string, any> | null {
  if (!marker) return null;
  if ('recharge' in marker) {
    const [min] = marker.recharge;
    return {
      max: '1',
      value: 1,
      spent: 0,
      recovery: [{ period: 'recharge', type: 'recoverAll', formula: String(min) }],
    };
  }
  const periodMap: Record<string, string> = {
    'day': 'lr',
    'long-rest': 'lr',
    'short-rest': 'sr',
    'turn': 'turn',
  };
  const recoveryPeriod = periodMap[marker.period] ?? 'lr';
  return {
    max: String(marker.count),
    value: marker.count,
    spent: 0,
    recovery: [{ period: recoveryPeriod, type: 'recoverAll' }],
  };
}

/**
 * Phase 12.1.3 — pick the best-effort display name for a batch entry. Used
 * for logging and per-entry result reporting; not load-bearing for the build
 * itself. Falls back through the input modes:
 *   actor_intent.name (Mode E)        — preferred, always present in Mode E
 *   creature_name (Mode A/B)          — when caller passed a Reloaded section heading
 *   actor_name (Mode C)               — passthrough rename
 *   compendium_base.itemId (Mode C)   — last resort before parse-by-source
 *   first <h2> in reloaded_source     — Reloaded markdown convention
 *   "<entry N>"                       — final fallback
 */
export function batchEntryName(entry: any, idx: number): string {
  if (entry?.actor_intent?.name) return String(entry.actor_intent.name);
  if (entry?.creature_name) return String(entry.creature_name);
  if (entry?.actor_name) return String(entry.actor_name);
  if (entry?.compendium_base?.itemId) {
    return `<base:${entry.compendium_base.itemId}>`;
  }
  if (typeof entry?.reloaded_source === 'string') {
    const m = entry.reloaded_source.match(/<h2[^>]*>([^<]+)<\/h2>/i);
    if (m) return m[1].trim();
  }
  return `<entry ${idx}>`;
}

// ----- Phase 3b helpers: copy-patch & scratch-build -------------------------

/** Minimal human-facing summary of a ParsedAction for tool responses. */
function summarizeParsedAction(p: ParsedAction): Record<string, any> {
  const out: Record<string, any> = {};
  if (p.attackType) out.attackType = p.attackType;
  if (p.attackBonus !== undefined) out.attackBonus = p.attackBonus;
  if (p.reach !== undefined) out.reach = p.reach;
  if (p.range) out.range = p.range;
  if (p.damage.length > 0) out.damage = p.damage;
  if (p.save) out.save = p.save;
  if (p.usage) out.usage = p.usage;
  return out;
}

/** Cheap pre-rank score before we pay for full-doc fetches. Exact name match > substring > Jaccard. */
function cheapNameScore(actionName: string, candidateName: string): number {
  const a = actionName.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  const b = candidateName.toLowerCase().trim();
  if (a === b) return 1.0;
  if (b.includes(a) || a.includes(b)) return 0.8;
  const aTokens = new Set(a.split(/\s+/).filter(t => t.length >= 3));
  const bTokens = new Set(b.split(/\s+/).filter(t => t.length >= 3));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of aTokens) if (bTokens.has(t)) overlap++;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

/** Convert a full compendium Item doc into an ActionCandidateFull for scoring. */
function docToActionCandidateFull(basic: ActionCandidateBasic, doc: any): ActionCandidateFull {
  const system = doc?.system ?? {};
  const activities = system.activities ?? {};
  const activityTypes = new Set<string>();
  const damageTypes = new Set<string>();
  const saveAbilities = new Set<string>();
  let totalMagnitude = 0;
  let rangeFeet: number | null = null;

  for (const act of Object.values<any>(activities)) {
    if (act?.type) activityTypes.add(String(act.type));

    // Damage types — the parts[].types can be an array of strings or an object map;
    // empty object {} means "inherit base dice types" (no signal).
    const parts = act?.damage?.parts ?? [];
    for (const part of parts) {
      if (Array.isArray(part.types)) {
        for (const t of part.types) if (t) damageTypes.add(String(t).toLowerCase());
      }
      // Approximate damage average: n * (d+1) / 2 for {number, denomination}, else parse custom formula
      if (typeof part.number === 'number' && typeof part.denomination === 'number' && part.denomination > 0) {
        totalMagnitude += part.number * (part.denomination + 1) / 2;
      } else if (part.custom?.enabled && part.custom.formula) {
        totalMagnitude += approxAverageFormula(String(part.custom.formula));
      }
    }

    // Save ability if present (SRD items usually don't set this — stays empty).
    if (act?.save?.ability) {
      const ability = Array.isArray(act.save.ability) ? act.save.ability[0] : act.save.ability;
      if (ability) saveAbilities.add(String(ability).toLowerCase());
    }

    // Range from first activity with one — reach preferred for melee.
    if (rangeFeet === null) {
      const rv = act?.range?.value;
      const rr = act?.range?.reach;
      if (typeof rr === 'number') rangeFeet = rr;
      else if (typeof rv === 'number') rangeFeet = rv;
      else if (typeof rv === 'string' && !isNaN(Number(rv))) rangeFeet = Number(rv);
    }
  }

  return {
    ...basic,
    activityTypes,
    damageTypes,
    saveAbilities,
    damageMagnitude: totalMagnitude,
    range: rangeFeet,
  };
}

function approxAverageFormula(formula: string): number {
  let sum = 0;
  for (const m of formula.matchAll(/(\d+)\s*d\s*(\d+)/g)) {
    const n = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (!isNaN(n) && !isNaN(d)) sum += n * (d + 1) / 2;
  }
  const flats = formula.match(/([+-]\s*\d+)(?!\s*d)/g);
  if (flats) for (const f of flats) sum += parseInt(f.replace(/\s+/g, ''), 10);
  return sum;
}

/**
 * Convert a ParsedAction into the wire-friendly ActionPatchSpec the module-side
 * addActorItemFromCompendium handler expects. Names kept short because this
 * blob travels over WebRTC.
 */
function buildActionPatchSpec(parsed: ParsedAction): Record<string, any> {
  const spec: Record<string, any> = {};
  if (parsed.attackBonus !== undefined) spec.attackBonus = parsed.attackBonus;
  if (parsed.attackType) spec.attackType = parsed.attackType;
  if (parsed.damage.length > 0) {
    spec.damageParts = parsed.damage.map(d => ({ formula: d.formula, type: d.type }));
  }
  if (parsed.reach !== undefined) spec.reach = parsed.reach;
  if (parsed.range) {
    spec.rangeNormal = parsed.range.normal;
    if (parsed.range.long !== undefined) spec.rangeLong = parsed.range.long;
  }
  if (parsed.save?.onSuccess === 'half') spec.onSaveHalf = true;
  if (parsed.save) {
    spec.saveAbility = parsed.save.ability;
    spec.saveDc = parsed.save.dc;
  }

  if (parsed.usage) {
    if ('recharge' in parsed.usage) {
      const [min] = parsed.usage.recharge;
      spec.uses = {
        max: '1',
        value: 1,
        spent: 0,
        recovery: [{ period: 'recharge', type: 'recoverAll', formula: String(min) }],
      };
    } else {
      const periodMap: Record<string, string> = {
        'day': 'lr',
        'long-rest': 'lr',
        'short-rest': 'sr',
        'turn': 'turn',
      };
      const recoveryPeriod = periodMap[parsed.usage.period] ?? 'lr';
      spec.uses = {
        max: String(parsed.usage.count),
        value: parsed.usage.count,
        spent: 0,
        recovery: [{ period: recoveryPeriod, type: 'recoverAll' }],
      };
    }
  }
  return spec;
}

// ----- Phase 3b extension: opt-in compendium-base pruning -------------------

/**
 * Items whose names should never be auto-pruned. Most are wrapper/header feats
 * (Multiattack), structural traits (Spellcasting, Legendary Resistance), or
 * persistent metadata (Lair Actions). Reloaded statblocks frequently rename
 * the *body* of these (e.g. "Sunlight Hypersensitivity" replacing the SRD
 * "Vampire Weaknesses") but Reloaded's keep-set won't catch the rename, so
 * we err on the side of preserving anything in this list.
 */
const PRUNE_ALWAYS_KEEP = new Set<string>([
  'multiattack',
  'spellcasting',
  'innate spellcasting',
  'legendary resistance',
  'legendary actions',
  'lair actions',
  'reactions',
  'magic resistance',
  'magic weapons',
  'shapechanger',
  'amphibious',
  'pack tactics',
  'keen senses',
  'keen hearing',
  'keen smell',
  'keen sight',
  'sunlight sensitivity',
  'sunlight hypersensitivity',
  'regeneration',
  'rejuvenation',
  'misty escape',
  'children of the night',
  'vampire weaknesses',
]);

/** Hard cap on auto-pruned items per build, regardless of candidate count. */
export const PRUNE_HARD_CAP = 5;

/**
 * Truth-table for the `prune_base_items` orchestrator gate.
 *
 * Default flipped 2026-05-17 per Arc H AAR:
 *   - undefined / true → prune runs (default behavior)
 *   - false            → prune skipped (explicit opt-out for Mode C passthrough
 *                        builds where Reloaded prose paraphrases base features
 *                        verbatim — Arc F Ernst Larnak case)
 *
 * Off-by-default produced silent Specter contamination on both Arc H Leo
 * Dilisnya forms (Life Drain, Incorporeal Movement, Sunlight Sensitivity).
 * The explicit `false` opt-out remains available for legitimate Mode C
 * passthrough cases.
 */
export function shouldRunBasePrune(input: { prune_base_items?: boolean | undefined }): boolean {
  return input.prune_base_items !== false;
}

/** English stop-tokens skipped when computing token overlap. */
const PRUNE_STOP_TOKENS = new Set<string>(['the', 'and', 'with', 'from', 'into', 'for']);

export interface PruneDecision {
  id: string;
  name: string;
  type: string;
  /** "prune" — pruned (or would have been, if over cap). "keep" with reason — preserved. */
  decision: 'prune' | 'keep';
  reason: string;
}

/**
 * Pick which compendium-base items to prune, given the Reloaded keep-set.
 * Pure function — no IO, fully testable in isolation. The caller decides
 * whether to actually delete (production: caps + opt-in flag; tests: just
 * inspect the decision list).
 *
 * Keep rules (first match wins):
 *   1. Item carries our own flag (`flags.foundry-forge-mcp.source`) — added
 *      this run, never prune. (Note: module-side getCharacterInfo currently
 *      strips item.flags from the response, so this branch is dead at runtime;
 *      kept as forward-compatibility for when flags become readable. Real
 *      preservation of our additions is via token-overlap below.)
 *   2. Item type is NOT in the prune-eligible set {'feat', 'weapon'}.
 *      Spells/equipment/classes/races/backgrounds/containers/loot stay safe;
 *      feats and weapons are in-scope because in dnd5e 5.x NPC attacks are
 *      `type=weapon` items (Bite, Claws, Longsword, Hail of Daggers), not feats.
 *   3. Item name (or its parenthetical-stripped stem) is in PRUNE_ALWAYS_KEEP.
 *   4. Item name has any 3+-char token overlap with a Reloaded trait/action
 *      name (case-insensitive, stop-tokens removed).
 *
 * Anything that fails all four checks is pruned — bounded by PRUNE_HARD_CAP.
 * Decisions over the cap come back as `decision='prune'` with a `cappedOver`
 * marker the caller can split off.
 */
export function selectPruneCandidates(
  items: Array<{ id?: string; _id?: string; name?: string; type?: string; flags?: any }>,
  reloadedNames: Iterable<string>,
): { decisions: PruneDecision[]; toPrune: PruneDecision[]; cappedOver: PruneDecision[] } {
  const reloadedTokens = new Set<string>();
  for (const n of reloadedNames) {
    for (const t of nameTokens(n)) reloadedTokens.add(t);
  }

  const decisions: PruneDecision[] = [];
  const candidates: PruneDecision[] = [];

  for (const item of items) {
    const id = String(item.id ?? item._id ?? '');
    const name = String(item.name ?? '').trim();
    const type = String(item.type ?? '');
    if (!id || !name) continue;

    const ourFlag = item.flags?.['foundry-forge-mcp']?.source;
    if (ourFlag) {
      decisions.push({ id, name, type, decision: 'keep', reason: `ours: ${ourFlag}` });
      continue;
    }
    if (type !== 'feat' && type !== 'weapon') {
      decisions.push({ id, name, type, decision: 'keep', reason: `type=${type}` });
      continue;
    }

    const lower = name.toLowerCase();
    const stem = lower.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (PRUNE_ALWAYS_KEEP.has(lower) || PRUNE_ALWAYS_KEEP.has(stem)) {
      decisions.push({ id, name, type, decision: 'keep', reason: 'ALWAYS_KEEP' });
      continue;
    }

    const itemTokens = nameTokens(name);
    let matchedToken: string | null = null;
    for (const t of itemTokens) {
      if (reloadedTokens.has(t)) {
        matchedToken = t;
        break;
      }
    }
    if (matchedToken) {
      decisions.push({ id, name, type, decision: 'keep', reason: `token-match:${matchedToken}` });
      continue;
    }

    candidates.push({ id, name, type, decision: 'prune', reason: 'no Reloaded match (compendium-base feat)' });
  }

  const toPrune = candidates.slice(0, PRUNE_HARD_CAP);
  const cappedOver = candidates.slice(PRUNE_HARD_CAP);
  return { decisions: decisions.concat(candidates), toPrune, cappedOver };
}

function nameTokens(s: string): Set<string> {
  const stem = s.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
  const out = new Set<string>();
  for (const tok of stem.split(/[\s,;:'"-]+/)) {
    const clean = tok.replace(/[^a-z]/g, '');
    if (clean.length >= 3 && !PRUNE_STOP_TOKENS.has(clean)) out.add(clean);
  }
  return out;
}

