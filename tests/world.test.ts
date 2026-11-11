import { describe, expect, it } from 'vitest';
import { buildChunk } from '../src/world/chunkBuild';
import { hash32, mulberry32 } from '../src/world/rng';
import { TerrainGen } from '../src/world/terrain';

/** design §7 test "World generation is deterministic" */
function hashArray(a: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) h = hash32(h, Math.round(a[i] * 1000));
  return h;
}

describe('world generation', () => {
  it('rng is deterministic', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('same seed gives identical heights and airfields; different seeds differ', () => {
    const g1 = new TerrainGen(1234);
    const g2 = new TerrainGen(1234);
    const g3 = new TerrainGen(4321);
    let diff = 0;
    for (let i = 0; i < 200; i++) {
      const x = (i * 977) % 20000 - 10000;
      const z = (i * 613) % 20000 - 10000;
      expect(g1.height(x, z)).toBe(g2.height(x, z));
      if (Math.abs(g1.height(x, z) - g3.height(x, z)) > 1) diff++;
    }
    expect(diff).toBeGreaterThan(150);
    expect(g1.airfields).toEqual(g2.airfields);
  });

  it('chunks are identical regardless of build order, at every LOD', () => {
    const seed = 1234;
    const chunks: [number, number][] = [
      [0, 0],
      [5, -3],
      [100, 40],
    ];
    for (const res of [8, 16, 32, 64]) {
      const forward = chunks.map(([cx, cz], i) => buildChunk(new TerrainGen(seed), { id: i, seed, cx, cz, res, props: res >= 32 }));
      const gen = new TerrainGen(seed);
      const backward = [...chunks].reverse().map(([cx, cz], i) => buildChunk(gen, { id: i, seed, cx, cz, res, props: res >= 32 })).reverse();
      forward.forEach((a, i) => {
        const b = backward[i];
        expect(hashArray(a.positions)).toBe(hashArray(b.positions));
        expect(hashArray(a.colors)).toBe(hashArray(b.colors));
        expect(hashArray(a.props)).toBe(hashArray(b.props));
      });
    }
  });

  it('home airfield is on land and its strip is flat', () => {
    for (const seed of [1, 42, 1234, 99999, 777]) {
      const g = new TerrainGen(seed);
      const af = g.airfields[0];
      expect(af.home).toBe(true);
      expect(af.height).toBeGreaterThan(5);
      for (const u of [-240, -120, 0, 120, 240])
        for (const v of [-18, 0, 18]) {
          const x = af.x + af.dirX * u - af.dirZ * v;
          const z = af.z + af.dirZ * u + af.dirX * v;
          expect(Math.abs(g.height(x, z) - af.height)).toBeLessThan(0.01);
          expect(g.runwayAt(x, z, 1)).toBe(af);
        }
    }
  });

  it('mostly land around the start, with sea and mountains somewhere', () => {
    const g = new TerrainGen(42);
    let land = 0;
    let max = -Infinity;
    let min = Infinity;
    let n = 0;
    for (let z = -10000; z <= 10000; z += 400)
      for (let x = -10000; x <= 10000; x += 400) {
        const h = g.height(x, z);
        if (h > 0) land++;
        max = Math.max(max, h);
        min = Math.min(min, h);
        n++;
      }
    expect(land / n).toBeGreaterThan(0.5);
    expect(min).toBeLessThan(0);
    expect(max).toBeGreaterThan(300);
  });
});
