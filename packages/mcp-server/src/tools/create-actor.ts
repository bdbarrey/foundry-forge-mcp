import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';
import { parseReloadedStatblock, ReloadedStatblock } from '../parsers/reloaded-statblock.js';
import { ParsedAction, parseActionDescription } from '../parsers/action-description.js';
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
}

interface CompendiumBase {
  packId: string;
  itemId: string;
}

export class CreateActorTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: CreateActorToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'CreateActorTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-actor',
        description:
          'Build a Foundry actor from a CoS Reloaded statblock. Phase 2 MVP: compendium-hybrid path only — spawns from a compendium base (auto-searched by creature name if not given) and overrides numeric stats from the Reloaded statblock (HP, AC, speed, ability scores, CR, save proficiencies). Does NOT yet sync custom traits/actions, skills, damage/condition immunities, portraits, or move to a specific folder — those land in Phase 3+. Provide EITHER reloaded_source (the raw markdown chunk) OR file_path+creature_name (the tool reads the file and extracts the `### <creature_name>` section).',
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
    }).refine(
      d => d.reloaded_source || (d.file_path && d.creature_name),
      { message: 'Provide reloaded_source OR both file_path and creature_name' },
    );
    const input = schema.parse(args);

    this.logger.info('create-actor invoked', {
      hasSource: !!input.reloaded_source,
      filePath: input.file_path,
      creatureName: input.creature_name,
      explicitBase: !!input.compendium_base,
    });

    try {
      // 1. Get markdown source
      const markdown = await this.resolveSource(input);

      // 2. Parse Reloaded statblock
      const sb = parseReloadedStatblock(markdown);
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
      const updateResults = await this.applyOverridesChunked(newActor.id, sb, input);
      // Concatenate successfully-written field keys for the response.
      const successfulUpdateKeys = updateResults.filter(r => r.ok).flatMap(r => r.fields);
      const failedUpdateChunks = updateResults.filter(r => !r.ok).map(r => ({ chunk: r.label, error: r.error }));

      // 7. Add Reloaded-only traits (no attack/damage/save — pure narrative).
      //    Traits whose names already exist on the actor (e.g. "Sunlight
      //    Sensitivity" inherited from the compendium Wight) are left alone;
      //    updating divergent descriptions ships in Phase 3a-C.
      const traitsToAdd = sb.traits
        .filter(t => !existingItemNames.has(t.name.toLowerCase()))
        .map(t => ({
          name: t.name,
          type: 'feat',
          system: {
            description: { value: `<p>${escapeHtml(t.description)}</p>` },
            source: { book: 'CoS Reloaded' },
            type: { value: 'monster' },
          },
        }));
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
      const itemsByName = new Map<string, any>();
      for (const item of actorFull?.items ?? []) {
        itemsByName.set(String(item.name ?? '').toLowerCase(), item);
      }
      const allReloadedActions = [
        ...sb.actions, ...sb.bonusActions, ...sb.reactions,
        ...sb.legendaryActions, ...sb.lairActions,
      ];
      const itemUpdates: Array<Record<string, any>> = [];
      const actionsSynced: string[] = [];
      const actionsSkippedNoItem: string[] = [];
      const actionsSkippedNoActivity: string[] = [];

      for (const action of allReloadedActions) {
        const item = itemsByName.get(action.name.toLowerCase());
        if (!item) {
          actionsSkippedNoItem.push(action.name);
          continue;
        }
        const activities = item.system?.activities ?? {};
        if (!activities || Object.keys(activities).length === 0) {
          actionsSkippedNoActivity.push(action.name);
          continue;
        }
        // Walk every activity on the item and patch only the fields relevant
        // to that activity's type. One item can have both an `attack` and a
        // `save` activity (e.g. Wight Commander Life Drain) — both need
        // Reloaded's values applied.
        const itemUpdate = buildItemActivityUpdate(item.id, activities, action.parsed);
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
            const r: any = await this.foundryClient.query(
              'foundry-forge-mcp.addActorItemFromCompendium',
              {
                actorId: newActor.id,
                packId: top.cand.packId,
                itemId: top.cand.itemId,
                renameTo: name,
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
            const itemPayload = this.buildScratchActionItem(name, action.description, action.parsed);
            const addResult = await this.addItemsWithBatchFallback(newActor.id, [itemPayload]);
            if (addResult.added.length > 0) {
              actionsScratchBuilt.push(name);
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
        flagsStamped: ['foundry-forge-mcp.source', 'foundry-forge-mcp.reloadedName']
          .concat(input.file_path ? ['foundry-forge-mcp.reloadedPath'] : []),
        notes: [
          'Phase 3a-B: numeric overrides + skills/senses/languages/immunities/prof-bonus applied; Reloaded-only traits added as simple feats.',
          'Phase 3a-C: existing action items updated with Reloaded attack bonus, damage parts, save DC, reach/range (targeting the item\'s primary attack/save activity).',
          'Reloaded-only ACTIONS (not traits) that don\'t exist on the compendium base are not auto-created yet — add manually or wait for a follow-up phase.',
          'Versatile weapon alternatives (e.g. "or 2d10+4 slashing if two-handed") are parsed but not yet written to the item — dnd5e represents these via a separate activity path, shipping later.',
          'Actor landed in default folder "Foundry MCP Creatures" — move manually for now.',
        ],
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'create-actor', 'actor creation');
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
  private buildScratchActionItem(
    name: string,
    description: string,
    parsed?: import('../parsers/action-description.js').ParsedAction,
  ): Record<string, any> {
    const system: any = {
      description: { value: `<p>${escapeHtml(description)}</p>` },
      source: { book: 'CoS Reloaded' },
      type: { value: 'monster' },
    };

    // If the parsed action has a save (Tanglefoot, Thunderstone, etc.) attach
    // a save activity so the DM can roll it from the sheet. Without this the
    // feat is description-only — DM has to remember to call for a saving throw
    // and apply effects manually. Damage rides the save activity when present
    // (matches the buildItemActivityUpdate damageGoesOnSave path).
    if (parsed?.save) {
      const activityId = genActivityId();
      const saveActivity: any = {
        type: 'save',
        _id: activityId,
        name: 'Save',
        save: {
          ability: [parsed.save.ability],
          dc: { calculation: '', formula: String(parsed.save.dc) },
        },
      };
      if (parsed.damage.length > 0) {
        saveActivity.damage = {
          parts: parsed.damage.map(damagePartPayload),
          onSave: parsed.save.onSuccess === 'half' ? 'half' : 'none',
        };
      }
      if (parsed.range) {
        saveActivity.range = {
          value: parsed.range.normal,
          units: 'ft',
          ...(parsed.range.long ? { long: parsed.range.long } : {}),
        };
      }
      system.activities = { [activityId]: saveActivity };
    }

    return {
      name,
      type: 'feat',
      system,
      flags: {
        'foundry-forge-mcp': { source: 'reloaded-scratch-action' },
      },
    };
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
  ): Promise<Array<{ label: string; fields: string[]; ok: boolean; error?: string }>> {
    const flagsChunk: Record<string, any> = {};
    this.stampFlags(flagsChunk, sb, input);

    const chunks: Array<{ label: string; payload: Record<string, any> }> = [
      { label: 'core-numerics', payload: this.buildCoreNumericsChunk(sb) },
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

  private buildCoreNumericsChunk(sb: ReloadedStatblock): Record<string, any> {
    const u: Record<string, any> = {};
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
    const prof = sb.proficiencyBonus ?? 0;
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

/** Extract the markdown chunk under `### <heading>` in a file. Stops at next `##`/`###`. */
export function extractStatblockSection(
  fileContent: string,
  heading: string,
  sourcePath?: string,
): string {
  const lines = fileContent.split(/\r?\n/);
  const startIdx = lines.findIndex(l => l.trim() === `### ${heading}`);
  if (startIdx < 0) {
    const where = sourcePath ? ` in ${sourcePath}` : '';
    throw new Error(`Heading "### ${heading}" not found${where}`);
  }
  const relEnd = lines.slice(startIdx + 1).findIndex(l => /^#{1,3}\s/.test(l));
  const end = relEnd < 0 ? lines.length : startIdx + 1 + relEnd;
  return lines.slice(startIdx, end).join('\n');
}

// ----- dnd5e system maps -----------------------------------------------------

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
  const u: Record<string, any> = { _id: itemId };

  // Where does parsed damage belong? attack-bonus implies a Hit:-style attack,
  // so damage rides the attack activity. Otherwise (save-only prose like "must
  // succeed... or take 2d6 fire damage") it rides the save activity, even when
  // the BASE compendium item happens to also expose an attack activity (some
  // dnd5e 5.x bases like Alchemist's Fire ship both Midi Attack + Midi Save).
  // The discriminator is the parsed shape, not the base item's activity set.
  const damageGoesOnAttack = parsed.attackBonus !== undefined;
  const damageGoesOnSave = !damageGoesOnAttack && !!parsed.save;

  for (const [activityId, activity] of Object.entries(activities)) {
    const base = `system.activities.${activityId}`;
    const type = activity?.type;

    if (type === 'attack' && parsed.attackBonus !== undefined) {
      // dnd5e stores attack bonus as a string with leading sign. flat=true
      // makes the bonus the FULL attack roll modifier — without it, dnd5e
      // adds ability + prof on top, so Reloaded's "+7" displays as +14
      // (bonus +7 + Dex +4 + prof +3) on Hail of Daggers.
      u[`${base}.attack.bonus`] = (parsed.attackBonus >= 0 ? '+' : '') + parsed.attackBonus;
      u[`${base}.attack.flat`] = true;
      if (parsed.attackType) {
        u[`${base}.attack.type.value`] = parsed.attackType;
      }

      if (damageGoesOnAttack && parsed.damage.length > 0) {
        u[`${base}.damage.parts`] = parsed.damage.map(damagePartPayload);
        // Reloaded prints the FULL damage formula (e.g. "2d4 + 4" already
        // includes ability mod). dnd5e's default `includeBase=true` adds the
        // weapon's base die on top, so Hail of Daggers becomes 4d4+8 instead
        // of 2d4+4. Suppress base contribution whenever we override damage.
        u[`${base}.damage.includeBase`] = false;
      }

      // Reach / range live on the attack activity. dnd5e 4.x normalizes these
      // to numbers in the document model — writing strings here used to silently
      // not stick (the compendium dump shows `range.value: 5` etc, never a string).
      if (parsed.reach !== undefined) {
        u[`${base}.range.reach`] = parsed.reach;
        u[`${base}.range.units`] = 'ft';
      }
      if (parsed.range) {
        u[`${base}.range.value`] = parsed.range.normal;
        if (parsed.range.long) u[`${base}.range.long`] = parsed.range.long;
        u[`${base}.range.units`] = 'ft';
      }
    }

    if (type === 'save' && parsed.save) {
      // dnd5e 5.x SaveActivity schema: { ability: SetField, dc: { calculation, formula } }.
      // calculation="" + formula="<N>" = custom DC (skip derivation).
      // Writing the full save object (not dot-path fragments) is required when the
      // activity's save is absent at defaults — partial-merge leaves the SetField
      // uninitialized and silently no-ops.
      u[`${base}.save`] = {
        ability: [parsed.save.ability],
        dc: { calculation: '', formula: String(parsed.save.dc) },
      };

      if (damageGoesOnSave && parsed.damage.length > 0) {
        u[`${base}.damage.parts`] = parsed.damage.map(damagePartPayload);
        if (parsed.save.onSuccess === 'half') {
          u[`${base}.damage.onSave`] = 'half';
        }
        // Range belongs on whichever activity carries the action (the one
        // getting damage). For save-only AoE actions like Volenta's Firebomb
        // ("within 30 feet") the range goes on the save activity since the
        // attack branch never fires.
        if (parsed.range) {
          u[`${base}.range.value`] = parsed.range.normal;
          if (parsed.range.long) u[`${base}.range.long`] = parsed.range.long;
          u[`${base}.range.units`] = 'ft';
        }
      }
    }

    if (type === 'damage' && parsed.damage.length > 0) {
      u[`${base}.damage.parts`] = parsed.damage.map(damagePartPayload);
    }
  }

  return u;
}

function genActivityId(): string {
  // dnd5e activity IDs are 16 alphanumeric chars (matches Foundry's standard
  // doc id length). Random-only — collisions across activities on the same
  // item are vanishingly unlikely at 16 chars from 62 alphabet.
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function damagePartPayload(d: { formula: string; type: string }) {
  // dnd5e 4.x damage-part shape: { custom: { enabled: true, formula }, types: [type] }.
  // Using a custom formula sidesteps dice-denomination bookkeeping.
  return {
    custom: { enabled: true, formula: d.formula },
    types: [d.type],
  };
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

