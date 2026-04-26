// Phase 5c: apply-actor-portrait.
//
// Retroactive portrait/token application on an existing actor — same
// resolver/pair-detector/apply pipeline as create-actor's portrait arg, but
// untethered from a build. For "swap Strahd's existing actor portrait to my
// new generated one" without rebuilding the whole actor.
//
// Delegates to CreateActorTools.resolveAndApplyPortrait so all four pair
// conventions (Beneos `_token`, Tokenizer `.Token`, sibling Avatars/Tokens,
// sibling Portrait/Token) and all three apply modes (auto / single /
// tokenizer) work identically here.

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from '../utils/error-handler.js';
import { CreateActorTools } from './create-actor.js';

export interface ApplyActorPortraitToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
  // Required: this tool delegates the resolve+apply to the existing pipeline.
  createActorTools: CreateActorTools;
}

export class ApplyActorPortraitTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;
  private createActorTools: CreateActorTools;

  constructor({ foundryClient, logger, createActorTools }: ApplyActorPortraitToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'ApplyActorPortraitTools' });
    this.errorHandler = new ErrorHandler(this.logger);
    this.createActorTools = createActorTools;
  }

  getToolDefinitions() {
    return [
      {
        name: 'apply-actor-portrait',
        description:
          'Retroactively apply a portrait + token to an existing actor — same Forge folder lookup / pair-convention detection / convention modes as create-actor\'s `portrait` arg, but operates on an actor you already have. Two modes: explicit `path` (URL/Foundry-relative path applied as-is) or `lookup` (browses a Forge folder recursively, fuzzy-matches the actor name against filenames, detects portrait/token pair conventions). Convention=auto detects pairs across four shapes (Beneos `_token` suffix, Tokenizer `.Token` suffix, sibling Avatars/Tokens, sibling Portrait/Token); convention=single forces same URL on both slots; convention=tokenizer sets only `img` and lets the Tokenizer module on the client generate the token. Useful for: swapping a portrait you don\'t love, applying an AI-generated portrait after the fact, or fixing a build where the original portrait lookup missed.',
        inputSchema: {
          type: 'object',
          properties: {
            actorId: {
              type: 'string',
              description: 'ID of the actor to update. Use this OR actorName.',
            },
            actorName: {
              type: 'string',
              description: 'Name of the actor to update. Use this OR actorId.',
            },
            path: {
              type: 'string',
              description: 'Explicit Foundry-relative path or full URL. Skips the lookup step.',
            },
            lookup: {
              type: 'object',
              description: 'Fuzzy-match against a Forge folder by actor name. Recursive by default.',
              properties: {
                folder: {
                  type: 'string',
                  description: 'Foundry-relative Forge folder. Defaults to the Beneos cos_tokens path.',
                },
                minScore: {
                  type: 'number',
                  description: 'Minimum fuzzy-match score [0..1] to auto-apply (default 0.5).',
                  minimum: 0, maximum: 1,
                },
                names: {
                  type: 'array',
                  description: 'Override the candidate names. Default: actor\'s display name + nameVariants (pre-comma stem, role-stripped). Pass alternate spellings here when needed.',
                  items: { type: 'string' },
                },
                recursive: {
                  type: 'boolean',
                  description: 'Walk subdirs (default true).',
                },
              },
            },
            convention: {
              type: 'string',
              enum: ['auto', 'single', 'tokenizer'],
              description: 'How to apply the resolved image. auto (default) detects pair convention; single uses one URL for both portrait+token; tokenizer sets only img and leaves prototypeToken alone (Tokenizer module generates the token client-side).',
            },
            applyToToken: {
              type: 'boolean',
              description: 'Also set prototypeToken.texture.src (default true; ignored when convention=tokenizer).',
            },
          },
        },
      },
    ];
  }

  async handleApplyActorPortrait(args: any): Promise<any> {
    const schema = z.object({
      actorId: z.string().optional(),
      actorName: z.string().optional(),
      path: z.string().optional(),
      lookup: z.object({
        folder: z.string().optional(),
        minScore: z.number().min(0).max(1).optional(),
        names: z.array(z.string()).optional(),
        recursive: z.boolean().optional(),
      }).optional(),
      convention: z.enum(['auto', 'single', 'tokenizer']).optional(),
      applyToToken: z.boolean().optional(),
    }).refine(d => d.actorId || d.actorName, {
      message: 'Provide actorId or actorName',
    }).refine(d => d.path || d.lookup, {
      message: 'Provide either path (explicit URL) or lookup (folder fuzzy-match)',
    });
    const input = schema.parse(args);

    this.logger.info('apply-actor-portrait invoked', {
      actorId: input.actorId,
      actorName: input.actorName,
      mode: input.path ? 'explicit' : 'lookup',
      folder: input.lookup?.folder,
      convention: input.convention ?? 'auto',
    });

    try {
      // Resolve actor identifier — getCharacterInfo accepts either id or name
      // through the same `characterName` param. Fail loudly here so we don't
      // silently apply to the wrong actor.
      const identifier = input.actorId ?? input.actorName!;
      const actorRaw: any = await this.foundryClient.query(
        'foundry-forge-mcp.getCharacterInfo',
        { characterName: identifier },
      );
      if (!actorRaw) {
        throw new Error(`Actor "${identifier}" not found via getCharacterInfo`);
      }
      const inner = actorRaw.character ?? actorRaw.actor ?? actorRaw;
      const actor = {
        id: inner.id ?? inner._id ?? identifier,
        name: inner.name ?? identifier,
      };

      // Build the portrait-options shape that resolveAndApplyPortrait expects.
      // Same shape as create-actor's `portrait` arg.
      const portraitOptions = {
        path: input.path,
        lookup: input.lookup,
        convention: input.convention,
        applyToToken: input.applyToToken,
      };

      // Synthesize a minimal sb for the resolver — only `.name` is read, used
      // to build candidate name variants when `lookup.names` isn't overridden.
      const portraitResult = await this.createActorTools.resolveAndApplyPortrait(
        actor,
        { name: actor.name } as any,
        portraitOptions,
      );

      return {
        success: true,
        actorId: actor.id,
        actorName: actor.name,
        portrait: portraitResult,
      };
    } catch (error) {
      this.errorHandler.handleToolError(error, 'apply-actor-portrait', 'portrait application');
    }
  }
}
