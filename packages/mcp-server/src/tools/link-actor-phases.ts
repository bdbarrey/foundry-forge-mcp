// Phase 7: link-actor-phases.
//
// Wires multi-form actors (Volenta → 2nd Form, Rahadin → Kinslayer, Strahd
// Mage → Soldier → Vampire, etc.) using dnd5e 4.x's native `transform`
// activity. NOT MidiQOL — the transformation is fully driven by dnd5e core.
//
// Canonical reference: Rahadin, Castle Chamberlain's "Murderous Instinct"
// feat (probed live 2026-04-26 via get-character-entity). Activity shape
// captured below in `buildTransformActivity`.
//
// Two operations:
//   - link-actor-phases (primitive)  — wires ONE phase boundary by adding a
//                                      feat with a transform activity that
//                                      points at the next-phase actor's UUID.
//   - link-phase-chain (wrapper)     — takes an ordered list of N actors and
//                                      wires N-1 boundaries with the
//                                      standardized naming convention:
//                                      `2nd Form` → `3rd Form` → ... →
//                                      `Final Form` for the last link.
//
// The terminal actor in a chain receives no transform feat — it's the end
// of the line. Each phase only knows about its immediate successor; the
// 1st form does NOT carry a 3rd-form link.

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';

/**
 * Marker for user-facing errors that should bypass `ErrorHandler.handleToolError`.
 * The shared handler categorizes errors by keyword sniffing and falls back to a
 * generic "An unexpected error occurred" wrapper that drops the original message
 * into `details` (which the formatted output never surfaces). For our
 * disambiguation / not-found errors we want the verbatim message to reach the
 * user — throwing this subclass signals "let it through".
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export interface LinkActorPhasesToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/**
 * Compute the standardized feat-slot name for the link from `index` (0-based)
 * to `index + 1` in a chain of `total` actors.
 *
 * Convention: terminal-pointing slot is always `Final Form`. Intermediate
 * slots are `2nd Form`, `3rd Form`, etc. Examples:
 *   total=2 →  ["Final Form"]
 *   total=3 →  ["2nd Form", "Final Form"]
 *   total=4 →  ["2nd Form", "3rd Form", "Final Form"]
 */
export function chainSlotName(index: number, total: number): string {
  if (index < 0 || index >= total - 1) {
    throw new Error(`chainSlotName: index ${index} out of range for chain of ${total}`);
  }
  // Last link (pointing at the terminal actor) is always "Final Form".
  if (index === total - 2) return 'Final Form';
  // Intermediate links: "2nd Form" at index 0, "3rd Form" at index 1, etc.
  const ordinal = index + 2;
  const suffix = ordinalSuffix(ordinal);
  return `${ordinal}${suffix} Form`;
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

/**
 * Build the dnd5e 4.x transform activity object that swaps the actor's token
 * to the target actor's prototype on activation.
 *
 * Shape verified against Rahadin's Murderous Instinct → 2nd Phase activity
 * (probed 2026-04-26). Static defaults (visibility, target, midiProperties,
 * etc.) match what dnd5e initializes when the activity is created via the
 * sheet UI; the load-bearing fields are `type`, `name`, `activation.type`,
 * `profiles[0].uuid`, and `settings.transformTokens`.
 */
export function buildTransformActivity(
  activityId: string,
  activityName: string,
  targetActorId: string,
): Record<string, any> {
  return {
    _id: activityId,
    type: 'transform',
    name: activityName,
    img: 'systems/dnd5e/icons/svg/activity/transform.svg',
    sort: 0,
    activation: {
      type: 'special',
      value: null,
      condition: '',
      override: false,
      scalar: false,
    },
    consumption: {
      scaling: { allowed: false },
      spellSlot: true,
      targets: [],
    },
    description: { chatFlavor: '' },
    duration: {
      value: null,
      units: 'inst',
      concentration: false,
      override: false,
      scalar: false,
    },
    effects: [],
    flags: {},
    range: {
      value: null,
      units: 'self',
      special: '',
      override: false,
      scalar: false,
    },
    target: {
      template: {
        count: null, contiguous: false, stationary: false,
        type: '', size: null, width: null, height: null,
        units: 'ft',
      },
      affects: { count: null, type: '', choice: false, scalar: '' },
      override: false,
      prompt: true,
    },
    uses: { spent: 0, max: '', recovery: [], value: 0, label: '' },
    visibility: {
      identifier: '',
      level: { min: null, max: null },
      requireAttunement: false,
      requireIdentification: false,
      requireMagic: false,
    },
    profiles: [{
      level: { min: null, max: null },
      movement: [],
      name: '',
      sizes: [],
      types: [],
      uuid: `Actor.${targetActorId}`,
    }],
    settings: {
      effects: ['origin', 'otherOrigin', 'background', 'class', 'feat', 'equipment', 'spell'],
      keep: ['vision'],
      merge: [],
      other: [],
      preset: '',
      spellLists: [],
      transformTokens: true,
    },
    transform: { customize: false, mode: '', preset: '' },
  };
}

/**
 * Build the full feat-item document that wraps the transform activity.
 * Stamps `flags.foundry-forge-mcp.source: 'phase-link'` so future tools (and
 * the Phase 3b prune logic) can recognize this as ours.
 */
export function buildPhaseLinkFeat(
  featName: string,
  description: string,
  activity: Record<string, any>,
): Record<string, any> {
  const activities: Record<string, any> = {};
  activities[activity._id] = activity;
  return {
    name: featName,
    type: 'feat',
    img: 'systems/dnd5e/icons/svg/activity/transform.svg',
    system: {
      activities,
      description: { value: description, chat: '' },
      type: { value: 'monster', subtype: '' },
      source: { rules: '2024' },
      identifier: '',
      properties: [],
      uses: { spent: 0, max: '', recovery: [] },
    },
    flags: {
      'foundry-forge-mcp': {
        source: 'phase-link',
        targetActorId: activity.profiles?.[0]?.uuid?.replace(/^Actor\./, '') ?? null,
      },
    },
  };
}

function genActivityId(): string {
  // dnd5e activity IDs are 16 alphanumeric chars (Foundry doc-id length).
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

const DEFAULT_DESCRIPTION = (featName: string, fromName: string, toName: string) =>
  `<p>When ${fromName} drops to 0 hit points, ${fromName}'s statistics are instantly ` +
  `replaced by the statistics of ${toName} (${featName}). Initiative count doesn't ` +
  `change. Excess damage doesn't carry over to the new form.</p>`;

export class LinkActorPhasesTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: LinkActorPhasesToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'LinkActorPhasesTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'link-actor-phases',
        description:
          'Wire ONE phase boundary on a multi-form actor. Adds a feat to the `from` actor with a dnd5e 4.x native `transform` activity that points at the `to` actor. When the GM clicks the feat at HP 0, dnd5e core handles the token swap (no MidiQOL needed). For 2-phase actors (Volenta → 2nd Form) this is one call. For longer chains (Strahd Mage → Soldier → Vampire, Ludmilla 1st → Elementalist → Mistfiend) call once per phase boundary, OR use `link-phase-chain` to do all boundaries in one shot.',
        inputSchema: {
          type: 'object',
          properties: {
            from: {
              type: 'string',
              description: 'Source actor (the earlier phase). Accepts actor name or id. The transform feat is added to this actor.',
            },
            to: {
              type: 'string',
              description: 'Target actor (the later phase). Accepts actor name or id. This actor\'s UUID is what the activity profiles[0].uuid points at.',
            },
            feat_name: {
              type: 'string',
              description: 'Standardized feat slot name. Default "Final Form" — the right answer for 2-phase actors and for the last link in any chain. Use "2nd Form" / "3rd Form" / etc. for intermediate links in N-phase chains.',
              default: 'Final Form',
            },
            description: {
              type: 'string',
              description: 'Optional narrative HTML for the feat description. If omitted, a generic stub is used.',
            },
          },
          required: ['from', 'to'],
        },
      },
      {
        name: 'link-phase-chain',
        description:
          'Convenience wrapper that wires N-1 phase boundaries for an ordered list of N actors. Naming follows the convention: intermediate slots get ordinal names (`2nd Form`, `3rd Form`, ...) and the last slot (the one pointing at the terminal actor) is always `Final Form`. Example: chain=["Strahd The Mage", "Strahd The Soldier", "Strahd The Vampire"] wires Mage→Soldier as `2nd Form` and Soldier→Vampire as `Final Form`. The terminal actor receives no feat — it\'s the end of the chain. Per chain semantics, each actor only knows about its immediate successor.',
        inputSchema: {
          type: 'object',
          properties: {
            chain: {
              type: 'array',
              description: 'Ordered list of actor names or ids, earliest phase first. Minimum 2 entries.',
              items: { type: 'string' },
              minItems: 2,
            },
          },
          required: ['chain'],
        },
      },
    ];
  }

  async handleLinkActorPhases(args: any): Promise<any> {
    const schema = z.object({
      from: z.string().min(1, 'from is required'),
      to: z.string().min(1, 'to is required'),
      feat_name: z.string().min(1).optional(),
      description: z.string().optional(),
    });
    const input = schema.parse(args);
    const featName = input.feat_name ?? 'Final Form';

    this.logger.info('link-actor-phases invoked', {
      from: input.from, to: input.to, featName,
    });

    try {
      return await this.linkOne(input.from, input.to, featName, input.description);
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      this.errorHandler.handleToolError(error, 'link-actor-phases', 'phase link');
    }
  }

  async handleLinkPhaseChain(args: any): Promise<any> {
    const schema = z.object({
      chain: z.array(z.string().min(1)).min(2, 'chain must have at least 2 actors'),
    });
    const { chain } = schema.parse(args);

    this.logger.info('link-phase-chain invoked', { length: chain.length });

    const links: any[] = [];
    try {
      for (let i = 0; i < chain.length - 1; i++) {
        const featName = chainSlotName(i, chain.length);
        const result = await this.linkOne(chain[i], chain[i + 1], featName);
        links.push({ index: i, from: chain[i], to: chain[i + 1], featName, ...result });
      }
      return { success: true, chainLength: chain.length, links };
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      this.errorHandler.handleToolError(error, 'link-phase-chain', 'phase chain link');
    }
  }

  private async linkOne(
    fromIdent: string,
    toIdent: string,
    featName: string,
    description?: string,
  ): Promise<any> {
    // Resolve both actors with strict ambiguity detection. Two actors named
    // "Volenta" in the world (older world entry + freshly-built one from this
    // session) silently collapsed onto the wrong one previously; the resolver
    // now refuses and demands an id.
    const [fromActor, toActor] = await Promise.all([
      this.resolveActor(fromIdent, 'from'),
      this.resolveActor(toIdent, 'to'),
    ]);

    // Pre-flight: warn (don't block) if the source already has a feat with
    // this slot name. addActorItems will create a duplicate; the user can
    // manually clean up, but we surface it in the response.
    const fromInfo: any = await this.foundryClient.query(
      'foundry-forge-mcp.getCharacterInfo', { characterName: fromActor.id },
    );
    const existingItems: any[] = fromInfo?.items
      ?? fromInfo?.character?.items
      ?? fromInfo?.actor?.items
      ?? [];
    const duplicateSlot = existingItems.find(
      (i: any) => i?.name?.toLowerCase?.() === featName.toLowerCase(),
    );

    const activityId = genActivityId();
    const activityName = featName; // user-facing activity label matches feat name
    const activity = buildTransformActivity(activityId, activityName, toActor.id);
    const desc = description ?? DEFAULT_DESCRIPTION(featName, fromActor.name, toActor.name);
    const featDoc = buildPhaseLinkFeat(featName, desc, activity);

    const addResult: any = await this.foundryClient.query(
      'foundry-forge-mcp.addActorItems',
      { actorId: fromActor.id, items: [featDoc] },
    );

    return {
      success: true,
      from: { id: fromActor.id, name: fromActor.name },
      to: { id: toActor.id, name: toActor.name },
      featName,
      activityName,
      featId: addResult?.added?.[0]?._id ?? null,
      activityId,
      duplicateSlotWarning: duplicateSlot
        ? { existingFeatId: duplicateSlot.id ?? duplicateSlot._id, name: duplicateSlot.name }
        : null,
      notes: [
        'dnd5e 4.x native transform activity — no MidiQOL required.',
        'Click the feat in Foundry at HP=0 to trigger the swap; dnd5e creates a merged actor named "<from> (<to>)" on first activation.',
        ...(duplicateSlot ? [`Duplicate slot "${featName}" already on source actor — created a second one. Remove old one manually if not desired.`] : []),
      ],
    };
  }

  /**
   * Resolve a name-or-id identifier to a unique actor. Refuses and throws if
   * a name matches multiple actors in the world; the caller must then pass an
   * actor id to disambiguate. Designed to eliminate the silent "first match
   * wins" footgun that bit during Phase 7 testing (two "Volenta" actors).
   *
   * Resolution order:
   *   1. listActors with nameContains — collect candidates whose name OR id
   *      EXACTLY matches the identifier (case-insensitive on names, exact on
   *      ids). If multiple → throw ambiguity error. If one → return it.
   *   2. If none from step 1, fall back to getCharacterInfo (accepts ids and
   *      unique names). If that returns an actor, use it.
   *   3. Otherwise throw not-found.
   */
  private async resolveActor(
    identifier: string,
    role: string,
  ): Promise<{ id: string; name: string }> {
    // listActors with nameContains is a substring search on names; ids never
    // match by substring (16-char alphanumerics rarely appear inside actor
    // names), so for the id case this returns 0 hits and we fall through.
    const listed: any = await this.foundryClient.query(
      'foundry-forge-mcp.listActors', { nameContains: identifier },
    );
    const candidates: any[] = Array.isArray(listed?.actors)
      ? listed.actors
      : Array.isArray(listed) ? listed : [];

    const lowered = identifier.toLowerCase();
    const exact = candidates.filter(a =>
      (typeof a?.name === 'string' && a.name.toLowerCase() === lowered)
      || a?.id === identifier,
    );

    if (exact.length > 1) {
      const lines = exact.map(a => `  - ${a.name} (id: ${a.id})`).join('\n');
      throw new UserFacingError(
        `Ambiguous ${role} actor "${identifier}" — ${exact.length} actors match exactly:\n${lines}\nPass an actor id instead of the name to disambiguate.`,
      );
    }

    if (exact.length === 1) {
      return { id: exact[0].id, name: exact[0].name };
    }

    // Fall back to getCharacterInfo for the id case (and for one-off names
    // that listActors didn't surface for some reason).
    const info: any = await this.foundryClient.query(
      'foundry-forge-mcp.getCharacterInfo', { characterName: identifier },
    );
    const inner = info?.character ?? info?.actor ?? info ?? {};
    const id = inner?.id ?? inner?._id;
    const name = inner?.name;
    if (!id) {
      throw new UserFacingError(`${role} actor "${identifier}" not found`);
    }
    return { id, name: name ?? identifier };
  }
}
