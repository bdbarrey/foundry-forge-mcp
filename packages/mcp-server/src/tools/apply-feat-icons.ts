// Phase 9: apply-feat-icons.
//
// Retrofit pass for actors built before Phase 9 shipped, or for hand-curated
// actors where a few feats still carry the generic star. Walks every item on
// the actor, runs the same resolver as create-actor (`resolveFeatIcon`), and
// updates `img` for items that:
//
//   1. Have one of the dnd5e/Foundry default icons (DND5E_DEFAULT_FEAT_ICONS), or
//   2. Are missing `img` entirely, or
//   3. Are explicitly named in the request (`itemIds: [...]`) for force-reset.
//
// Items with a non-default img are left alone — the user picked something
// custom and we won't clobber it. Pass `force: true` to override that and
// re-resolve every prune-eligible item.
//
// Prune-eligible types: `feat` only by default. Spells/equipment/weapons get
// their own icon flow elsewhere (compendium import preserves them).

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';
import {
  resolveFeatIcon,
  DND5E_DEFAULT_FEAT_ICONS,
  FEATURE_FALLBACK_PATH,
  validateIconUrl,
} from './feat-icons.js';
import { parseActionDescription } from '../parsers/action-description.js';

export interface ApplyFeatIconsToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class ApplyFeatIconsTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: ApplyFeatIconsToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'ApplyFeatIconsTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'apply-feat-icons',
        description:
          'Retrofit themed icons onto an actor\'s feat items. Walks every `type=feat` item, runs the create-actor icon resolver against the name + parsed combat shape, and updates `img` where it matches the dnd5e/Foundry default star or is missing entirely. Items with a custom (non-default) img are left alone unless `force: true`. Use this on actors built before Phase 9 shipped, or when you want to refresh icons across an entire NPC.',
        inputSchema: {
          type: 'object',
          properties: {
            actorId: {
              type: 'string',
              description: 'ID of the actor (use this OR actorName).',
            },
            actorName: {
              type: 'string',
              description: 'Name of the actor (use this OR actorId). Note: if multiple actors share this name the resolver picks the first match silently — pass an id when in doubt.',
            },
            itemIds: {
              type: 'array',
              description: 'Optional. Restrict the pass to specific item ids; bypasses the default-icon-only filter for these items.',
              items: { type: 'string' },
            },
            force: {
              type: 'boolean',
              description: 'When true, re-resolve icons even on items with a custom img. Default false.',
            },
            includeFallback: {
              type: 'boolean',
              description: 'When true, also apply the generic feature fallback when the resolver finds no themed match. When false (default), items that would only get the fallback are skipped so we don\'t replace one generic icon with another.',
            },
          },
        },
      },
    ];
  }

  async handleApplyFeatIcons(args: any): Promise<any> {
    const schema = z.object({
      actorId: z.string().optional(),
      actorName: z.string().optional(),
      itemIds: z.array(z.string()).optional(),
      force: z.boolean().optional(),
      includeFallback: z.boolean().optional(),
    }).refine(d => d.actorId || d.actorName, {
      message: 'Provide actorId or actorName',
    });
    const input = schema.parse(args);
    const force = input.force ?? false;
    const includeFallback = input.includeFallback ?? false;
    const idFilter = input.itemIds ? new Set(input.itemIds) : null;

    this.logger.info('apply-feat-icons invoked', {
      actorId: input.actorId,
      actorName: input.actorName,
      force,
      includeFallback,
      idFilterSize: idFilter?.size ?? 0,
    });

    try {
      const identifier = input.actorId ?? input.actorName!;
      const info: any = await this.foundryClient.query(
        'foundry-forge-mcp.getCharacterInfo',
        { characterName: identifier },
      );
      if (!info) throw new Error(`Actor "${identifier}" not found`);
      const inner = info.character ?? info.actor ?? info;
      const actorId = inner.id ?? inner._id;
      const actorName = inner.name ?? identifier;
      if (!actorId) throw new Error(`Actor "${identifier}" has no id`);

      const items: any[] = inner.items ?? [];
      const updates: Array<{ _id: string; img: string }> = [];
      const considered: any[] = [];
      const skipped: any[] = [];

      for (const item of items) {
        const id = item?.id ?? item?._id;
        const type = item?.type;
        const name = String(item?.name ?? '');
        const currentImg = String(item?.img ?? '');

        if (idFilter && !idFilter.has(id)) continue;
        if (type !== 'feat') {
          skipped.push({ id, name, reason: `type=${type} (only feats are retrofit)` });
          continue;
        }

        // Eligibility: known-default icon, missing img, OR an http(s) URL
        // that fails HEAD probing. The third clause catches future broken
        // URLs we haven't enumerated in DND5E_DEFAULT_FEAT_ICONS — when an
        // item img 404s, replace it.
        const isDefault =
          !currentImg
          || DND5E_DEFAULT_FEAT_ICONS.has(currentImg);
        let brokenHttp = false;
        if (!isDefault && /^https?:\/\//.test(currentImg)) {
          brokenHttp = !(await validateIconUrl(currentImg));
        }
        const explicitlyTargeted = idFilter?.has(id) ?? false;
        if (!force && !explicitlyTargeted && !isDefault && !brokenHttp) {
          skipped.push({ id, name, reason: `custom img preserved (${currentImg})` });
          continue;
        }

        // Re-derive parsed action shape from the item's description so the
        // resolver's combat-shape heuristics fire (save → save icon etc.).
        // Description is HTML; the parser strips tags via its own normalize
        // step, so passing raw HTML is safe.
        const desc = String(item?.description ?? item?.system?.description?.value ?? '');
        const stripped = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const parsed = stripped ? parseActionDescription(stripped) : null;

        const newImg = await resolveFeatIcon(name, parsed);
        if (!includeFallback && newImg === FEATURE_FALLBACK_PATH) {
          skipped.push({ id, name, reason: 'no themed match (fallback excluded)' });
          continue;
        }
        if (newImg === currentImg) {
          considered.push({ id, name, img: currentImg, action: 'no-change' });
          continue;
        }

        const reason = brokenHttp ? 'broken-http' : (isDefault ? 'default' : 'forced');
        updates.push({ _id: id, img: newImg });
        considered.push({ id, name, img: newImg, was: currentImg, reason, action: 'update' });
      }

      if (updates.length === 0) {
        return {
          success: true,
          actorId,
          actorName,
          updated: 0,
          considered,
          skipped,
        };
      }

      const updateResult: any = await this.foundryClient.query(
        'foundry-forge-mcp.updateActorItems',
        { actorId, updates },
      );

      return {
        success: !!updateResult?.success,
        actorId,
        actorName,
        updated: updates.length,
        updateResult,
        considered,
        skipped,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'apply-feat-icons', 'icon retrofit');
    }
  }
}
