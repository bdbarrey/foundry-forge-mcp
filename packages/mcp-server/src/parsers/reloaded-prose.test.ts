import { describe, it, expect } from 'vitest';
import { parseReloadedProseSpec } from './reloaded-prose.js';

describe('parseReloadedProseSpec', () => {
  it('parses Father Lucian: priest base + Divine Eminence override', () => {
    const md = `### 2. Father Lucian
[[Non-Player Characters#Father Lucian Petrovich|Father Lucian]] retains the statistics of a **priest**. However, his ***divine eminence*** feature now reads as follows:

* ***Divine Eminence.*** As a reaction when he sees another creature within 30 feet hit with a weapon attack, Father Lucian can expend a spell slot to cause that attack to magically deal an extra 10 (3d6) radiant damage to a target on a hit. If Father Lucian expends a spell slot of 2nd level or higher, the extra damage increases by 1d6 for each level above 1st.

In combat, Father Lucian directs the players to form a defensive line...`;

    const spec = parseReloadedProseSpec(md);
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe('Father Lucian');
    expect(spec!.baseHint).toBe('priest');
    expect(spec!.featureOverrides).toHaveLength(1);
    expect(spec!.featureOverrides[0].name).toBe('Divine Eminence');
    expect(spec!.featureOverrides[0].description).toContain('reaction when he sees');
    expect(spec!.featureOverrides[0].description).toContain('extra 10 (3d6) radiant');
    // Description should NOT include the "In combat..." narrative paragraph.
    expect(spec!.featureOverrides[0].description).not.toContain('directs the players');
  });

  it('strips leading number prefix from heading: "### 2. Father Lucian" → "Father Lucian"', () => {
    const md = `### 2. Father Lucian
foo retains the statistics of a **priest**.`;
    const spec = parseReloadedProseSpec(md);
    expect(spec!.name).toBe('Father Lucian');
  });

  it('handles "has the statistics of" variant (Wensencia\'s steed)', () => {
    const md = `Wensencia's steed has the statistics of a **dire wolf**, but has a **zombie**'s ***undead fortitude*** feature instead of a dire wolf's ***pack tactics*** feature.`;
    const spec = parseReloadedProseSpec(md);
    expect(spec).not.toBeNull();
    // First bolded creature wins as baseHint
    expect(spec!.baseHint).toBe('dire wolf');
  });

  it('handles "Treat as" variant (Arc P crawling zombie)', () => {
    const md = `Treat the crawling zombie as a **zombie** with the following modifications:

* ***Crawl.*** The crawling zombie's speed is reduced to 10 feet, and it can only crawl.

* ***Reach.*** The crawling zombie's bite has a reach of 0 feet.`;
    const spec = parseReloadedProseSpec(md);
    expect(spec!.baseHint).toBe('zombie');
    expect(spec!.featureOverrides).toHaveLength(2);
    expect(spec!.featureOverrides[0].name).toBe('Crawl');
    expect(spec!.featureOverrides[1].name).toBe('Reach');
  });

  it('returns null when no recognizable patterns', () => {
    const md = `Just narrative prose with no statistics references and no bullet overrides.`;
    expect(parseReloadedProseSpec(md)).toBeNull();
  });

  it('returns spec with only baseHint when no feature overrides', () => {
    const md = `Rictavio retains the statistics of a **veteran**. He travels with his pet tiger.`;
    const spec = parseReloadedProseSpec(md);
    expect(spec).not.toBeNull();
    expect(spec!.baseHint).toBe('veteran');
    expect(spec!.featureOverrides).toEqual([]);
  });

  it('extracts name from heading even without [[link]]', () => {
    const md = `### Bandit Captain Smith
The captain has the statistics of a **bandit captain**.`;
    const spec = parseReloadedProseSpec(md);
    expect(spec!.name).toBe('Bandit Captain Smith');
  });

  it('extracts name from bare [[link]] when no heading', () => {
    const md = `[[Some Page#Father Lucian]] retains the statistics of a **priest**.`;
    const spec = parseReloadedProseSpec(md);
    expect(spec!.name).toBe('Father Lucian');
  });

  it('handles multi-word base creatures with internal spaces', () => {
    const md = `Treat as a **adult red dragon** with these modifications:`;
    const spec = parseReloadedProseSpec(md);
    expect(spec!.baseHint).toBe('adult red dragon');
  });

  it('strips trailing punctuation from baseHint', () => {
    const md = `Has the statistics of a **wight**. The rest is narrative.`;
    const spec = parseReloadedProseSpec(md);
    expect(spec!.baseHint).toBe('wight');
  });

  it('preserves italics within feature description', () => {
    const md = `Has the statistics of a **priest**.

* ***Smite.*** Channel divine energy from *spirit guardians* to deal radiant damage.`;
    const spec = parseReloadedProseSpec(md);
    expect(spec!.featureOverrides[0].description).toContain('*spirit guardians*');
  });

  it('does NOT consume narrative paragraphs after the bullet list', () => {
    const md = `Has the statistics of a **priest**.

* ***Override.*** Short override description.

The priest moves around the battlefield casting spells.`;
    const spec = parseReloadedProseSpec(md);
    expect(spec!.featureOverrides[0].description).toBe('Short override description.');
    expect(spec!.featureOverrides[0].description).not.toContain('moves around');
  });
});
