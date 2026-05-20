import { describe, it, expect, vi } from 'vitest';
import { ApplyActorPortraitTools } from './apply-actor-portrait.js';
import { Logger } from '../logger.js';

// Minimal stubs — the tool is mostly a thin delegate, so tests focus on
// input validation, actor resolution, and that the right pipeline call
// is made with the right candidate names.

const makeLogger = (): Logger => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: () => makeLogger(),
} as any);

const makeFoundryClient = (queryImpl: (q: string, args: any) => any) =>
  ({ query: vi.fn(queryImpl) } as any);

const makeCreateActorTools = (resolveImpl: (...args: any[]) => any) => ({
  resolveAndApplyPortrait: vi.fn(resolveImpl),
} as any);

describe('ApplyActorPortraitTools — input validation', () => {
  it('rejects when neither actorId nor actorName provided', async () => {
    const tool = new ApplyActorPortraitTools({
      foundryClient: makeFoundryClient(() => ({})),
      logger: makeLogger(),
      createActorTools: makeCreateActorTools(() => ({ applied: true })),
    });
    await expect(tool.handleApplyActorPortrait({ path: 'foo.png' }))
      .rejects.toThrow();
  });

  it('rejects when neither path nor lookup provided', async () => {
    const tool = new ApplyActorPortraitTools({
      foundryClient: makeFoundryClient(() => ({})),
      logger: makeLogger(),
      createActorTools: makeCreateActorTools(() => ({ applied: true })),
    });
    await expect(tool.handleApplyActorPortrait({ actorId: 'abc' }))
      .rejects.toThrow();
  });
});

describe('ApplyActorPortraitTools — actor resolution', () => {
  it('passes the resolved actor and synthesized sb to the resolver', async () => {
    const foundryClient = makeFoundryClient((q, args) => {
      if (q === 'foundry-forge-mcp.getCharacterInfo') {
        return { id: 'actor123', name: 'Strahd von Zarovich', system: {}, items: [] };
      }
    });
    const resolveSpy = vi.fn(() => ({ applied: true, mode: 'lookup' }));
    const createActorTools = makeCreateActorTools(resolveSpy);

    const tool = new ApplyActorPortraitTools({
      foundryClient, logger: makeLogger(), createActorTools,
    });

    const result = await tool.handleApplyActorPortrait({
      actorName: 'Strahd',
      lookup: { folder: 'My Avatars' },
      convention: 'tokenizer',
    });

    expect(result.success).toBe(true);
    expect(result.actorId).toBe('actor123');
    expect(result.actorName).toBe('Strahd von Zarovich');
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    const [actor, sb, options] = resolveSpy.mock.calls[0];
    expect(actor.id).toBe('actor123');
    expect(actor.name).toBe('Strahd von Zarovich');
    // Synthesized sb only carries `.name` for nameVariants — the resolver's
    // own logic decides whether to use it (it falls back to nameVariants only
    // when lookup.names isn't passed).
    expect(sb.name).toBe('Strahd von Zarovich');
    expect(options.lookup.folder).toBe('My Avatars');
    expect(options.convention).toBe('tokenizer');
  });

  it('passes the explicit path through unchanged', async () => {
    const foundryClient = makeFoundryClient(() =>
      ({ id: 'a', name: 'Test', system: {}, items: [] }));
    const resolveSpy = vi.fn(() => ({ applied: true }));
    const tool = new ApplyActorPortraitTools({
      foundryClient, logger: makeLogger(),
      createActorTools: makeCreateActorTools(resolveSpy),
    });

    await tool.handleApplyActorPortrait({
      actorId: 'a',
      path: 'moulinette/.../Volenta.webp',
    });

    const options = resolveSpy.mock.calls[0][2];
    expect(options.path).toBe('moulinette/.../Volenta.webp');
    expect(options.lookup).toBeUndefined();
  });

  it('handles getCharacterInfo response wrapped under .character', async () => {
    const foundryClient = makeFoundryClient(() => ({
      character: { id: 'wrapped123', name: 'Wrapped Actor' },
    }));
    const resolveSpy = vi.fn(() => ({ applied: true }));
    const tool = new ApplyActorPortraitTools({
      foundryClient, logger: makeLogger(),
      createActorTools: makeCreateActorTools(resolveSpy),
    });

    const result = await tool.handleApplyActorPortrait({
      actorId: 'wrapped123',
      path: 'foo.png',
    });

    expect(result.actorId).toBe('wrapped123');
    expect(result.actorName).toBe('Wrapped Actor');
  });

  it('throws when actor lookup returns null', async () => {
    const foundryClient = makeFoundryClient(() => null);
    const tool = new ApplyActorPortraitTools({
      foundryClient, logger: makeLogger(),
      createActorTools: makeCreateActorTools(() => ({ applied: true })),
    });

    await expect(tool.handleApplyActorPortrait({
      actorId: 'doesnotexist',
      path: 'foo.png',
    })).rejects.toThrow();
  });

  it('forwards lookup.names override into the pipeline options', async () => {
    const foundryClient = makeFoundryClient(() =>
      ({ id: 'a', name: 'Volenta', system: {}, items: [] }));
    const resolveSpy = vi.fn(() => ({ applied: true }));
    const tool = new ApplyActorPortraitTools({
      foundryClient, logger: makeLogger(),
      createActorTools: makeCreateActorTools(resolveSpy),
    });

    await tool.handleApplyActorPortrait({
      actorId: 'a',
      lookup: { folder: 'cos_tokens', names: ['valenta', 'valenta popofsky'] },
    });

    const options = resolveSpy.mock.calls[0][2];
    expect(options.lookup.names).toEqual(['valenta', 'valenta popofsky']);
  });
});
