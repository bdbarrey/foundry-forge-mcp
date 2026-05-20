// Phase 0+ (Arc H gap-closure plan 2026-05-17) — MCP tool wrapping
// parseReloadedSource so external callers (cos-pipeline's build_arc_catalog at
// Phase A, audit-actor's verify_activities mode at Phase 2) can consume the
// canonical ActorIntent without re-parsing the Reloaded source themselves.
//
// Pure tool: no Foundry calls, no network, no state. Just markdown → ActorIntent.
// Throws if the input doesn't contain a `<div class="statblock">` block.

import { z } from 'zod';
import type { Logger } from '../logger.js';
import { parseReloadedSource } from '../intent/builder.js';

const InputSchema = z.object({
  reloaded_source: z
    .string()
    .min(1, 'reloaded_source is required'),
});

type Input = z.infer<typeof InputSchema>;

export interface ParseReloadedSourceToolsOptions {
  logger: Logger;
}

export class ParseReloadedSourceTools {
  private logger: Logger;

  constructor({ logger }: ParseReloadedSourceToolsOptions) {
    this.logger = logger.child({ component: 'ParseReloadedSourceTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'parse-reloaded-source',
        description:
          'Parse a CoS Reloaded statblock markdown block into a canonical `ActorIntent` JSON. Pure function — no Foundry calls, no network. Use at Phase A to populate `foundry_data.actor_intents` for `build_arc_catalog` so the catalog can render the expected activity surface per NPC, and at Phase B/C as the comparison side for `audit-actor verify_activities=true`. The output is the same intent the create-actor pipeline builds against (Mode A): identity + AC/HP/abilities/saves/skills/senses/defenses + traits[] (classified into TRAIT_TEMPLATES kinds) + actions[]/bonusActions[]/reactions[]/legendaryActions[]/lairActions[] (each carrying activities[], conditions[], usage). Throws on input without a `<div class="statblock">` block — wrap a single Reloaded creature\'s statblock div per call.',
        inputSchema: {
          type: 'object',
          properties: {
            reloaded_source: {
              type: 'string',
              description:
                'Markdown containing exactly one `<div class="statblock">...</div>` block. Multi-form creatures (Volenta 1st + 2nd, Leo 1st + 2nd) require one call per form — pass each form\'s statblock div separately.',
            },
          },
          required: ['reloaded_source'],
        },
      },
    ];
  }

  /**
   * Handler — validates input, parses, returns the ActorIntent JSON.
   * Errors propagate as MCP tool errors (the parser throws on bad input).
   */
  async handleParseReloadedSource(args: unknown): Promise<unknown> {
    const input: Input = InputSchema.parse(args);
    this.logger.info('parse-reloaded-source called', { length: input.reloaded_source.length });
    const intent = parseReloadedSource(input.reloaded_source);
    return {
      success: true,
      actor_intent: intent,
      summary: {
        name: intent.name,
        cr: intent.cr,
        traits: intent.traits?.length ?? 0,
        actions: intent.actions?.length ?? 0,
        bonusActions: intent.bonusActions?.length ?? 0,
        reactions: intent.reactions?.length ?? 0,
        legendaryActions: intent.legendaryActions?.length ?? 0,
        lairActions: intent.lairActions?.length ?? 0,
      },
    };
  }
}
