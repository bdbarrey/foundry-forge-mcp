import { describe, it, expect } from 'vitest';
import { ParseReloadedSourceTools } from './parse-reloaded-source.js';

const noopLogger: any = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const MINIMAL_STATBLOCK = `<div class="statblock">
<h2>Test Goblin</h2>
<em>Small humanoid, neutral evil</em>
<hr>
<strong>Armor Class</strong> 15<br>
<strong>Hit Points</strong> 7 (2d6)<br>
<strong>Speed</strong> 30 ft.
<hr>
<table class="ability-table"><thead><tr><th>STR</th><th>DEX</th><th>CON</th><th>INT</th><th>WIS</th><th>CHA</th></tr></thead><tbody><tr><td>8 (-1)</td><td>14 (+2)</td><td>10 (+0)</td><td>10 (+0)</td><td>8 (-1)</td><td>8 (-1)</td></tr></tbody></table>
<hr>
<strong>Senses</strong> darkvision 60 ft., passive Perception 9<br>
<strong>Languages</strong> Common, Goblin<br>
<strong>Challenge</strong> CR 1/4<br>
<strong>Proficiency Bonus</strong> +2<br>
<hr>
<p><strong><em>Nimble Escape.</em></strong> The goblin can take the Disengage or Hide action as a bonus action on each of its turns.</p>
<h3>Actions</h3>
<p><strong><em>Scimitar.</em></strong> <em>Melee Weapon Attack:</em> +4 to hit, reach 5 ft., one target. <em>Hit:</em> 5 (1d6 + 2) slashing damage.</p>
</div>`;

describe('parse-reloaded-source MCP tool', () => {
  const tools = new ParseReloadedSourceTools({ logger: noopLogger });

  it('exposes a single tool definition with the expected name + schema', () => {
    const defs = tools.getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('parse-reloaded-source');
    expect((defs[0]!.inputSchema as any).required).toEqual(['reloaded_source']);
  });

  it('returns ActorIntent JSON + summary for a minimum-viable statblock', async () => {
    const result = (await tools.handleParseReloadedSource({
      reloaded_source: MINIMAL_STATBLOCK,
    })) as any;
    expect(result.success).toBe(true);
    expect(result.actor_intent.name).toBe('Test Goblin');
    expect(result.actor_intent.cr).toBe(0.25);
    expect(result.actor_intent.actions).toHaveLength(1);
    expect(result.actor_intent.actions[0].name).toBe('Scimitar');
    expect(result.summary).toEqual({
      name: 'Test Goblin',
      cr: 0.25,
      traits: 1,
      actions: 1,
      bonusActions: 0,
      reactions: 0,
      legendaryActions: 0,
      lairActions: 0,
    });
  });

  it('rejects empty reloaded_source via Zod validation', async () => {
    await expect(tools.handleParseReloadedSource({ reloaded_source: '' })).rejects.toThrow();
  });

  it('throws if input lacks a statblock div (delegates to parser)', async () => {
    await expect(
      tools.handleParseReloadedSource({ reloaded_source: 'just some prose, no statblock' }),
    ).rejects.toThrow();
  });
});
