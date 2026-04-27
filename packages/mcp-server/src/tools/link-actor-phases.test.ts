import { describe, it, expect } from 'vitest';
import {
  chainSlotName,
  buildTransformActivity,
  buildPhaseLinkFeat,
} from './link-actor-phases.js';

describe('chainSlotName', () => {
  it('returns "Final Form" for the only link in a 2-phase chain', () => {
    expect(chainSlotName(0, 2)).toBe('Final Form');
  });

  it('returns "2nd Form" then "Final Form" for a 3-phase chain', () => {
    expect(chainSlotName(0, 3)).toBe('2nd Form');
    expect(chainSlotName(1, 3)).toBe('Final Form');
  });

  it('returns "2nd Form", "3rd Form", "Final Form" for a 4-phase chain', () => {
    expect(chainSlotName(0, 4)).toBe('2nd Form');
    expect(chainSlotName(1, 4)).toBe('3rd Form');
    expect(chainSlotName(2, 4)).toBe('Final Form');
  });

  it('handles 5-phase using "4th Form" before terminal', () => {
    expect(chainSlotName(0, 5)).toBe('2nd Form');
    expect(chainSlotName(1, 5)).toBe('3rd Form');
    expect(chainSlotName(2, 5)).toBe('4th Form');
    expect(chainSlotName(3, 5)).toBe('Final Form');
  });

  it('terminal slot is always "Final Form" regardless of chain length', () => {
    for (const total of [2, 3, 4, 5, 10]) {
      expect(chainSlotName(total - 2, total)).toBe('Final Form');
    }
  });

  it('throws on out-of-range index', () => {
    expect(() => chainSlotName(-1, 3)).toThrow();
    expect(() => chainSlotName(2, 3)).toThrow(); // last actor has no outgoing link
    expect(() => chainSlotName(0, 1)).toThrow(); // 1-phase has no links
  });
});

describe('buildTransformActivity', () => {
  it('produces a dnd5e 4.x transform activity pointing at the target actor', () => {
    const a = buildTransformActivity('actId01234567890', 'Final Form', 'targetActorXyz');
    expect(a._id).toBe('actId01234567890');
    expect(a.type).toBe('transform');
    expect(a.name).toBe('Final Form');
    expect(a.activation.type).toBe('special');
    expect(a.profiles).toHaveLength(1);
    expect(a.profiles[0].uuid).toBe('Actor.targetActorXyz');
    expect(a.settings.transformTokens).toBe(true);
  });

  it('uses the dnd5e core transform icon', () => {
    const a = buildTransformActivity('a', 'X', 'b');
    expect(a.img).toBe('systems/dnd5e/icons/svg/activity/transform.svg');
  });

  it('keeps duration units = "inst" so the transformation does not auto-revert', () => {
    const a = buildTransformActivity('a', 'X', 'b');
    expect(a.duration.units).toBe('inst');
  });

  it('keeps "vision" in settings.keep so the new form retains sight modes', () => {
    // Rahadin's working setup keeps vision; without it the second form
    // resets to default vision and loses darkvision/etc.
    const a = buildTransformActivity('a', 'X', 'b');
    expect(a.settings.keep).toContain('vision');
  });

  it('settings.preset is empty (no transformation preset — uses default merge)', () => {
    const a = buildTransformActivity('a', 'X', 'b');
    expect(a.settings.preset).toBe('');
    expect(a.transform.preset).toBe('');
    expect(a.transform.customize).toBe(false);
  });
});

describe('buildPhaseLinkFeat', () => {
  it('wraps the activity in a feat document with the activity keyed by its _id', () => {
    const activity = buildTransformActivity('act00000000000ab', 'Final Form', 'tgt');
    const feat = buildPhaseLinkFeat('Final Form', '<p>desc</p>', activity);
    expect(feat.name).toBe('Final Form');
    expect(feat.type).toBe('feat');
    expect(feat.system.activities['act00000000000ab']).toBe(activity);
    expect(feat.system.description.value).toBe('<p>desc</p>');
  });

  it('stamps flags.foundry-forge-mcp.source = "phase-link" with the target actor id', () => {
    const activity = buildTransformActivity('a', 'X', 'targetActorXyz');
    const feat = buildPhaseLinkFeat('Final Form', 'desc', activity);
    expect(feat.flags['foundry-forge-mcp'].source).toBe('phase-link');
    expect(feat.flags['foundry-forge-mcp'].targetActorId).toBe('targetActorXyz');
  });

  it('uses the transform-activity SVG as the feat icon (UI affordance)', () => {
    const feat = buildPhaseLinkFeat('Final Form', 'd', buildTransformActivity('a', 'X', 'b'));
    expect(feat.img).toBe('systems/dnd5e/icons/svg/activity/transform.svg');
  });

  it('defaults source.rules to "2024" so the feat reads correctly under dnd5e 5.x', () => {
    const feat = buildPhaseLinkFeat('Final Form', 'd', buildTransformActivity('a', 'X', 'b'));
    expect(feat.system.source.rules).toBe('2024');
  });
});
