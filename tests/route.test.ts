import { describe, expect, it } from 'vitest';
import { TURN_RADIUS, airfieldNames, dubins, planRoute, pointAt, RouteTracker } from '../src/game/route';
import { TerrainGen } from '../src/world/terrain';

const SEEDS = [1, 7, 42, 1234, 98765, 31337, 555555, 2026, 777, 4242];
const WINDS = [
  { x: 3, z: 1 },
  { x: -2, z: 3.5 },
];

describe('cross-country routes (plan step 20)', () => {
  it('dubins paths end at the target pose with bounded curvature', () => {
    const r = 700;
    for (const [bx, bz, bh] of [
      [5000, 0, 0],
      [5000, 0, Math.PI],
      [-4000, 3000, 1],
      [300, 200, -2],
      [0, -6000, Math.PI / 2],
    ]) {
      const pts = dubins({ x: 0, z: 0, h: 0 }, { x: bx, z: bz, h: bh }, r, 10);
      const last = pts[pts.length - 1];
      expect(Math.hypot(last.x - bx, last.z - bz)).toBeLessThan(1);
      const prev = pts[pts.length - 2];
      const h = Math.atan2(last.z - prev.z, last.x - prev.x);
      expect(Math.abs(Math.sin((h - bh) / 2))).toBeLessThan(0.02);
    }
  });

  it('names every airfield, home first, all different', () => {
    for (const seed of SEEDS) {
      const names = airfieldNames(new TerrainGen(seed).airfields);
      expect(names[0]).toBe('Home Field');
      expect(new Set(names).size).toBe(names.length);
    }
  });

  for (const style of ['biplane', 'jet'] as const) {
    it(`${style}: every destination on ${SEEDS.length} seeds flies a safe, flyable path`, () => {
      const R = TURN_RADIUS[style];
      let standard = 0;
      let intoWind = 0;
      let total = 0;
      for (const seed of SEEDS) {
        const gen = new TerrainGen(seed);
        const home = gen.airfields[0];
        for (const wind of WINDS)
          for (const to of gen.airfields.slice(1)) {
            const r = planRoute(gen, home, to, wind, R);
            const pts = r.pts;
            const first = pts[0];
            const last = pts[pts.length - 1];
            // starts on the home runway, ends on the destination runway, at runway height
            expect(gen.runwayAt(first.x, first.z)).toBe(home);
            expect(gen.runwayAt(last.x, last.z)).toBe(to);
            expect(Math.abs(first.y - home.height - 2.5)).toBeLessThan(0.5);
            expect(Math.abs(last.y - to.height - 2.5)).toBeLessThan(0.5);
            // into the wind at both ends, unless the terrain says otherwise
            if (r.depart.dx * wind.x + r.depart.dz * wind.z <= 0 && r.land.dx * wind.x + r.land.dz * wind.z <= 0) intoWind++;

            let maxTurn = 0;
            for (let i = 1; i < pts.length; i++) {
              const a = pts[i - 1];
              const b = pts[i];
              const ds = b.s - a.s;
              if (ds < 1) continue;
              const grad = (b.y - a.y) / ds;
              // climb / descent gradients: as planned (steeper only where the terrain forces it)
              expect(grad).toBeLessThan(r.climb + 0.005);
              expect(grad).toBeGreaterThan(-r.glide - 0.005);
              // clear of the terrain away from the runways
              const g = Math.max(gen.height(b.x, b.z), 0);
              if (b.s > r.sLift + 1500 && b.s < r.sAim - 1500) expect(b.y - g).toBeGreaterThan(55);
              else if (b.s > r.sLift + 600 && b.s < r.sAim - 300) expect(b.y - g).toBeGreaterThan(9);
              else expect(b.y - g).toBeGreaterThan(-1);
              // turn radius: heading change per metre
              if (i >= 2) {
                const p = pts[i - 2];
                const h1 = Math.atan2(a.z - p.z, a.x - p.x);
                const h2 = Math.atan2(b.z - a.z, b.x - a.x);
                const dh = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
                maxTurn = Math.max(maxTurn, dh / ds);
              }
            }
            expect(maxTurn).toBeLessThan(1 / (R * 0.9));
            expect(r.climb).toBeLessThan(0.15);
            expect(r.glide).toBeLessThan(0.3);
            if (r.climb <= 0.1 && r.glide <= 0.1) standard++;
            total++;
            // final approach: straight, lined up, on a 4° slope
            for (const p of pts) {
              if (p.s < r.sFinal + 1 || p.s > r.sAim) continue;
              const ux = p.x - last.x;
              const uz = p.z - last.z;
              const cross = Math.abs(ux * r.land.dz - uz * r.land.dx);
              expect(cross).toBeLessThan(1);
            }
            // sensible length: longer than the straight line, not absurdly so
            const straight = Math.hypot(to.x - home.x, to.z - home.z);
            expect(r.length).toBeGreaterThan(straight * 0.8);
            expect(r.length).toBeLessThan(straight + 3 * Math.PI * R + 8000);
          }
      }
      // most routes climb and descend at under 6° (4.6° / 4° where the terrain allows)
      expect(standard / total).toBeGreaterThan(0.85);
      expect(intoWind / total).toBeGreaterThan(0.3);
      console.log(`${style}: ${total} routes, ${standard} standard gradients, ${intoWind} fully into the wind`);
    });
  }

  it('the tracker follows a plane flying the path and reports deviation', () => {
    const gen = new TerrainGen(42);
    const r = planRoute(gen, gen.airfields[0], gen.airfields[2], { x: 2, z: 1 });
    const t = new RouteTracker(r);
    const p = { x: 0, y: 0, z: 0 };
    for (let d = 0; d <= r.length; d += 30) {
      pointAt(r, d, p);
      t.update(p.x, p.y, p.z);
      expect(Math.abs(t.progress - d)).toBeLessThan(25);
      expect(t.onPath()).toBe(true);
    }
    pointAt(r, r.length / 2, p);
    const t2 = new RouteTracker(r);
    t2.update(p.x + 400, p.y, p.z);
    expect(t2.onPath()).toBe(false);
    expect(t2.lateral).toBeGreaterThan(300);
  });
});
