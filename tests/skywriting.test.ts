import { describe, expect, it } from 'vitest';
import { GLYPHS, sanitizeMessage } from '../src/game/skyfont';
import { SkyTracker, layoutMessage, planSkywriting, scoreWriting, skyCue, splitCorners, toText, writingRadius, type SkyPlan, type SmokePoint } from '../src/game/skywriting';
import { composeSpec, stallSpeed } from '../src/plane/loadout';
import { TerrainGen } from '../src/world/terrain';

/** circumradius of three points (Infinity when straight) */
function radius3(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }): number {
  const ab = Math.hypot(b.x - a.x, b.z - a.z);
  const bc = Math.hypot(c.x - b.x, c.z - b.z);
  const ca = Math.hypot(a.x - c.x, a.z - c.z);
  const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  return cross < 1e-9 ? Infinity : (ab * bc * ca) / (2 * cross);
}

/** smoke exactly where the plan says, every 2% of H */
function perfectSmoke(plan: SkyPlan): SmokePoint[] {
  const out: SmokePoint[] = [];
  for (const st of plan.strokes) for (const p of st.pts) out.push({ u: p.u, v: p.v, dy: 0 });
  // densify along the planned path's smoke segments
  for (const sg of plan.smoke)
    for (let i = 0; i < plan.pts.length; i++) if (plan.pts[i].s >= sg.s0 && plan.pts[i].s <= sg.s1) out.push({ ...plan.uv[i], dy: 0 });
  return out;
}

describe('skywriting (plan step 52)', () => {
  it('cleans up messages: upper case, known characters, two words, 12 characters', () => {
    expect(sanitizeMessage('hello world')).toBe('HELLO WORLD');
    expect(sanitizeMessage('  hi   there  you ')).toBe('HI THERE');
    expect(sanitizeMessage('abc#$%def')).toBe('ABCDEF');
    expect(sanitizeMessage('supercalifragilistic')).toBe('SUPERCALIFRA');
    expect(sanitizeMessage('skywriting rocks')).toBe('SKYWRITING RO');
    expect(sanitizeMessage('i ♥ u')).toBe('I U');
    expect(sanitizeMessage('???')).toBe('???');
    expect(sanitizeMessage('')).toBe('');
  });

  it('every glyph has strokes whose curves are no tighter than 0.18 em', () => {
    for (const [ch, g] of Object.entries(GLYPHS)) {
      expect(g.strokes.length, ch).toBeGreaterThan(0);
      for (const s of g.strokes)
        for (const part of splitCorners(s)) {
          for (let i = 1; i < part.length - 1; i++) {
            const [a, b, c] = [part[i - 1], part[i], part[i + 1]].map(([x, y]) => ({ x, z: y }));
            expect(radius3(a, b, c), `${ch} at ${b.x.toFixed(2)},${b.z.toFixed(2)}`).toBeGreaterThan(0.18);
          }
        }
    }
  });

  it('lays out letters left to right with gaps for spaces', () => {
    const l = layoutMessage('HI YO', 100);
    expect(l.letters.map((x) => x.ch).join('')).toBe('HIYO');
    for (let i = 1; i < l.letters.length; i++) expect(l.letters[i].u0).toBeGreaterThan(l.letters[i - 1].u1);
    expect(l.letters[2].u0 - l.letters[1].u1).toBeGreaterThan(l.letters[1].u0 - l.letters[0].u1);
  });

  for (const style of ['biplane', 'jet'] as const) {
    const r = writingRadius(stallSpeed(composeSpec({ style, paint: 'sunflower', wheels: 'medium' })));
    for (const seed of [1, 42, 2026]) {
      const gen = new TerrainGen(seed);
      const plan = planSkywriting(gen, gen.airfields[0], 'HELLO WORLD!', r, { x: 3, z: 1 });

      it(`${style}, seed ${seed}: about ${Math.round(plan.end / 1000)} km to write HELLO WORLD!`, () => {
        // keep the flight to a reasonable length: under ~4 km per letter
        expect(plan.end / plan.letters.length).toBeLessThan(plan.H * 7.5);
      });

      it(`${style}, seed ${seed}: a continuous, flyable path that clears the ground`, () => {
        expect(plan.H).toBeCloseTo(r * 4.5);
        for (let i = 1; i < plan.pts.length; i++) {
          const a = plan.pts[i - 1];
          const b = plan.pts[i];
          expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(10.5);
          expect(b.s).toBeGreaterThan(a.s);
        }
        // no turn much tighter than the writing radius (strokes ≥ 0.18 em = 0.81 r, connectors 0.85 r)
        for (let i = 2; i < plan.pts.length - 2; i++) expect(radius3(plan.pts[i - 2], plan.pts[i], plan.pts[i + 2])).toBeGreaterThan(r * 0.72);
        let hi = -Infinity;
        for (const p of plan.pts) hi = Math.max(hi, gen.height(p.x, p.z));
        expect(plan.alt - hi).toBeGreaterThanOrEqual(900);
        // one smoke segment per stroke, in order along the path
        expect(plan.smoke.length).toBe(plan.strokes.length);
        for (let i = 1; i < plan.smoke.length; i++) expect(plan.smoke[i].s0).toBeGreaterThan(plan.smoke[i - 1].s1);
        expect(plan.end).toBeGreaterThan(plan.smoke[plan.smoke.length - 1].s1);
        // the path and the text-space mapping agree
        const p = plan.pts[100];
        const q = toText(plan, p.x, p.z);
        expect(Math.hypot(q.u - plan.uv[100].u, q.v - plan.uv[100].v)).toBeLessThan(1e-6);
      });

      it(`${style}, seed ${seed}: perfect smoke scores 100, none 0, stray smoke costs neatness`, () => {
        const perfect = perfectSmoke(plan);
        const s = scoreWriting(plan, perfect);
        expect(s.score).toBeGreaterThanOrEqual(98);
        expect(s.medal).toBe(3);
        expect(s.letters.every((l) => l.score >= 95)).toBe(true);
        expect(scoreWriting(plan, []).score).toBe(0);
        // the same smoke plus as much again well clear of the letters (the smoke left on in the loops)
        const stray: SmokePoint[] = [...perfect, ...perfect.map((p) => ({ ...p, v: p.v + plan.H * 1.6 }))];
        const m = scoreWriting(plan, stray);
        expect(m.coverage).toBeGreaterThan(0.98);
        expect(m.neatness).toBeGreaterThan(0.45);
        expect(m.neatness).toBeLessThan(0.55);
        expect(m.score).toBeLessThan(s.score - 10);
        // smoke far below the writing altitude doesn't count
        expect(scoreWriting(plan, perfect.map((p) => ({ ...p, dy: -plan.H }))).score).toBe(0);
        // half the letters drawn: about half the coverage
        const half = perfect.filter((p) => p.u < plan.width / 2);
        const h = scoreWriting(plan, half);
        expect(h.coverage).toBeGreaterThan(0.3);
        expect(h.coverage).toBeLessThan(0.7);
      });

      it(`${style}, seed ${seed}: the tracker follows every loop without skipping ahead`, () => {
        const t = new SkyTracker(plan);
        const pts = plan.pts;
        for (let i = 0; i < pts.length - 1; i++) {
          // a few sub-steps per path point, a little off to the side
          for (let k = 0; k < 4; k++) {
            const f = k / 4;
            const x = pts[i].x + (pts[i + 1].x - pts[i].x) * f + 15;
            const z = pts[i].z + (pts[i + 1].z - pts[i].z) * f - 10;
            t.update(x, plan.alt + 20, z, pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
          }
          expect(Math.abs(t.progress - pts[i].s), `at s=${pts[i].s}`).toBeLessThan(40);
        }
        expect(skyCue(plan, t.progress).state).toBe('done');
      });
    }
  }

  it('cues: off far from a stroke, soon close to it, on along it, done after the last', () => {
    const gen = new TerrainGen(7);
    const plan = planSkywriting(gen, gen.airfields[0], 'HI', 100, { x: 0, z: 2 });
    const sg = plan.smoke[0];
    expect(skyCue(plan, 0).state).toBe('off');
    expect(skyCue(plan, sg.s0 - 100).state).toBe('soon');
    expect(skyCue(plan, (sg.s0 + sg.s1) / 2)).toMatchObject({ state: 'on', seg: 0 });
    expect(skyCue(plan, plan.end).state).toBe('done');
  });
});
