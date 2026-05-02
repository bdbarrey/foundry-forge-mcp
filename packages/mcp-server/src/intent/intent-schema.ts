// Phase 12.1.0 — Zod runtime schemas mirroring the activity-intent.ts types.
// Used by create-actor's `actions_intent` input mode to validate intents
// emitted by the orchestrating Claude session before they reach the writer.
//
// The TS types in activity-intent.ts are the authoritative shape; these Zod
// schemas reproduce them at runtime. When the two diverge, the TS types are
// the source of truth — update Zod to match. zInfer<typeof ActionIntentSchema>
// is exposed below for callers that want a Zod-derived TS type, but the
// canonical TS type stays in activity-intent.ts.
//
// Why this lives in its own file: keeps activity-intent.ts pure (no zod
// dependency) so consumers that only want types pay no runtime cost. Only
// the create-actor input boundary imports the Zod schemas.

import { z } from 'zod';

// ----- Primitive enums (mirror the unions from action-description.ts) -------

export const AbilityKeySchema = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);

export const AttackTypeSchema = z.enum(['melee', 'ranged']);

export const ConditionTypeSchema = z.enum([
  'blinded',
  'charmed',
  'deafened',
  'frightened',
  'grappled',
  'incapacitated',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
]);

export const TemplateShapeSchema = z.enum([
  'circle',
  'cone',
  'line',
  'cube',
  'sphere',
  'cylinder',
]);

export const ActivityKindSchema = z.enum(['attack', 'save', 'damage']);

export const TraitIntentKindSchema = z.enum([
  'pack-tactics',
  'sunlight-sensitivity',
  'description-only',
  'custom',
]);

/**
 * Custom trait effect spec — used when TraitIntent.kind === 'custom'.
 * The orchestrating Claude session emits this to express ActiveEffect
 * mechanics for traits not in TRAIT_TEMPLATES (Magic Resistance,
 * Regeneration, Spider Climb-with-effect, etc.).
 */
export const CustomTraitEffectSchema = z.object({
  effectName: z.string().min(1).optional(),
  img: z.string().optional(),
  statuses: z.array(z.string()).optional(),
  transfer: z.boolean().optional(),
  disabled: z.boolean().optional(),
  changes: z.array(z.object({
    key: z.string().min(1),
    value: z.string(),
    mode: z.number().int().optional(),
    priority: z.number().int().optional(),
  })).optional(),
  duration: z.object({
    rounds: z.number().int().nonnegative().optional(),
    seconds: z.number().int().nonnegative().optional(),
  }).optional(),
  flags: z.object({
    dae: z.object({
      transfer: z.boolean().optional(),
      stackable: z.string().optional(),
      specialDuration: z.array(z.string()).optional(),
      showIcon: z.boolean().optional(),
    }).optional(),
    'midi-qol': z.object({
      forceCEOff: z.boolean().optional(),
    }).optional(),
  }).optional(),
});

// ----- Sub-shapes -----------------------------------------------------------

export const DamagePartSchema = z.object({
  formula: z.string().min(1),
  type: z.string().min(1),
});

export const ParsedConditionDurationSchema = z.object({
  rounds: z.number().int().nonnegative().optional(),
  seconds: z.number().int().nonnegative().optional(),
  specialDuration: z
    .enum(['turnEnd', 'turnStart', 'turnEndSource', 'turnStartSource'])
    .optional(),
});

export const ParsedRepeatSaveSchema = z.object({
  period: z.enum(['turnEnd', 'turnStart']),
  ability: AbilityKeySchema,
  dc: z.number().int().positive(),
});

export const RangeIntentSchema = z.object({
  value: z.number().int().nonnegative().optional(),
  long: z.number().int().nonnegative().optional(),
  reach: z.number().int().nonnegative().optional(),
  units: z.literal('ft'),
});

export const TemplateIntentSchema = z.object({
  shape: TemplateShapeSchema,
  size: z.number().int().positive(),
  width: z.number().int().positive().optional(),
});

export const AffectsIntentSchema = z.object({
  type: z.enum(['creature', 'enemy', 'ally', 'object', 'self', 'space']),
  count: z.number().int().positive().optional(),
  choice: z.boolean().optional(),
});

export const TargetIntentSchema = z.object({
  template: TemplateIntentSchema.optional(),
  affects: AffectsIntentSchema.optional(),
});

export const AttackIntentSchema = z.object({
  bonus: z.number().int(),
  attackType: AttackTypeSchema.optional(),
});

export const SaveIntentSchema = z.object({
  ability: AbilityKeySchema,
  dc: z.number().int().positive(),
  onSuccess: z.literal('half').optional(),
});

export const DamageIntentSchema = z.object({
  parts: z.array(DamagePartSchema),
  includeBase: z.boolean().optional(),
  onSave: z.enum(['half', 'none', 'full']).optional(),
});

export const ActivityEffectLinkSchema = z.object({
  conditionRef: z.number().int().nonnegative(),
  onSave: z.boolean().optional(),
});

export const ActivityIntentSchema = z.object({
  intentId: z.string().min(1),
  kind: ActivityKindSchema,
  name: z.string().min(1),
  range: RangeIntentSchema.optional(),
  target: TargetIntentSchema.optional(),
  attack: AttackIntentSchema.optional(),
  save: SaveIntentSchema.optional(),
  damage: DamageIntentSchema.optional(),
  triggers: z
    .object({
      activityRef: z.string().min(1),
      targets: z.enum(['hit', 'all']),
    })
    .optional(),
  effects: z.array(ActivityEffectLinkSchema).optional(),
});

export const ConditionIntentSchema = z.object({
  type: ConditionTypeSchema,
  duration: ParsedConditionDurationSchema.optional(),
  repeatSave: ParsedRepeatSaveSchema.optional(),
});

// UsageIntent is a discriminated union: count+period OR recharge tuple.
export const UsageIntentSchema = z.union([
  z.object({
    count: z.number().int().positive(),
    period: z.enum(['day', 'long-rest', 'short-rest', 'turn']),
  }),
  z.object({
    recharge: z.tuple([
      z.number().int().min(1).max(20),
      z.number().int().min(1).max(20),
    ]),
  }),
]);

export const VersatileIntentSchema = z.object({
  formula: z.string().min(1),
  type: z.string().min(1),
});

export const ActionMidiPropertiesSchema = z.object({
  saveDamage: z.enum(['halfdam', 'fulldam', 'nodam']).optional(),
});

// ----- Top-level ActionIntent ----------------------------------------------

export const ActionIntentSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  usage: UsageIntentSchema.optional(),
  versatile: VersatileIntentSchema.optional(),
  midiProperties: ActionMidiPropertiesSchema.optional(),
  activities: z.array(ActivityIntentSchema),
  conditions: z.array(ConditionIntentSchema),
})
  // Cross-field invariants the writer relies on:
  // - effects[].conditionRef must be a valid index into conditions[]
  // - triggers.activityRef must match some other activity's intentId
  .superRefine((intent, ctx) => {
    const intentIds = new Set(intent.activities.map(a => a.intentId));
    intent.activities.forEach((activity, ai) => {
      if (activity.effects) {
        activity.effects.forEach((link, ei) => {
          if (link.conditionRef >= intent.conditions.length) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['activities', ai, 'effects', ei, 'conditionRef'],
              message: `conditionRef ${link.conditionRef} out of range (conditions has ${intent.conditions.length} entries)`,
            });
          }
        });
      }
      if (activity.triggers) {
        if (!intentIds.has(activity.triggers.activityRef)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['activities', ai, 'triggers', 'activityRef'],
            message: `triggers.activityRef '${activity.triggers.activityRef}' does not match any activity intentId in this action`,
          });
        }
        if (activity.triggers.activityRef === activity.intentId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['activities', ai, 'triggers', 'activityRef'],
            message: `activity cannot trigger itself`,
          });
        }
      }
    });
  });

export const TraitIntentSchema = z.object({
  kind: TraitIntentKindSchema,
  name: z.string().min(1),
  description: z.string(),
  custom: CustomTraitEffectSchema.optional(),
})
  // Cross-field invariant: kind='custom' requires the `custom` field with
  // the effect spec. Other kinds may include it but it's ignored.
  .superRefine((intent, ctx) => {
    if (intent.kind === 'custom' && !intent.custom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['custom'],
        message: "kind='custom' requires the `custom` field with the ActiveEffect spec",
      });
    }
  });

// ----- Phase 12.1.2 — ActorIntent (full statblock-level intent) ------------

export const CreatureSizeSchema = z.enum([
  'Tiny',
  'Small',
  'Medium',
  'Large',
  'Huge',
  'Gargantuan',
]);

export const ActorACIntentSchema = z.object({
  value: z.number().int().nonnegative(),
  note: z.string().optional(),
});

export const ActorHPIntentSchema = z.object({
  max: z.number().int().nonnegative(),
  formula: z.string().optional(),
});

export const ActorSpeedIntentSchema = z.object({
  walk: z.number().int().nonnegative().optional(),
  swim: z.number().int().nonnegative().optional(),
  fly: z.number().int().nonnegative().optional(),
  climb: z.number().int().nonnegative().optional(),
  burrow: z.number().int().nonnegative().optional(),
  hover: z.boolean().optional(),
});

export const ActorAbilityScoresSchema = z.object({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});

export const ActorSensesIntentSchema = z.object({
  darkvision: z.number().int().nonnegative().optional(),
  blindsight: z.number().int().nonnegative().optional(),
  truesight: z.number().int().nonnegative().optional(),
  tremorsense: z.number().int().nonnegative().optional(),
  passivePerception: z.number().int().nonnegative().optional(),
});

export const ActorPortraitIntentSchema = z.object({
  path: z.string().optional(),
  lookup: z.object({
    folder: z.string().optional(),
    minScore: z.number().min(0).max(1).optional(),
    names: z.array(z.string()).optional(),
    recursive: z.boolean().optional(),
  }).optional(),
  convention: z.enum(['auto', 'single', 'tokenizer']).optional(),
  applyToToken: z.boolean().optional(),
});

export const ActorIntentSchema = z.object({
  name: z.string().min(1),

  base: z.object({
    packId: z.string().min(1),
    itemId: z.string().min(1),
  }).optional(),

  size: CreatureSizeSchema.optional(),
  type: z.string().optional(),
  subtype: z.string().optional(),
  alignment: z.string().optional(),

  ac: ActorACIntentSchema.optional(),
  hp: ActorHPIntentSchema.optional(),
  speed: ActorSpeedIntentSchema.optional(),

  abilities: ActorAbilityScoresSchema.optional(),
  saves: z.record(AbilityKeySchema, z.number().int()).optional(),
  skills: z.record(z.string(), z.number().int()).optional(),

  senses: ActorSensesIntentSchema.optional(),

  damageResistances: z.array(z.string()).optional(),
  damageImmunities: z.array(z.string()).optional(),
  damageVulnerabilities: z.array(z.string()).optional(),
  conditionImmunities: z.array(ConditionTypeSchema).optional(),

  languages: z.array(z.string()).optional(),

  cr: z.union([z.number(), z.string()]).optional(),
  proficiencyBonus: z.number().int().nonnegative().optional(),

  traits: z.array(TraitIntentSchema).optional(),
  actions: z.array(ActionIntentSchema).optional(),
  bonusActions: z.array(ActionIntentSchema).optional(),
  reactions: z.array(ActionIntentSchema).optional(),
  legendaryActions: z.array(ActionIntentSchema).optional(),
  lairActions: z.array(ActionIntentSchema).optional(),

  portrait: ActorPortraitIntentSchema.optional(),
});

// ----- Type inference helpers ----------------------------------------------

export type ActionIntentZ = z.infer<typeof ActionIntentSchema>;
export type ActivityIntentZ = z.infer<typeof ActivityIntentSchema>;
export type ConditionIntentZ = z.infer<typeof ConditionIntentSchema>;
export type TraitIntentZ = z.infer<typeof TraitIntentSchema>;
export type ActorIntentZ = z.infer<typeof ActorIntentSchema>;
