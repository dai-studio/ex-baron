import type { Airfield } from '../world/terrain';

/**
 * Cross-country route planner (plan step 20). Pure and three-free so it can be
 * tested headless and drawn on the menu map before the sortie starts.
 *
 * The path, in order:
 *  1. take-off roll down the home runway, into the wind;
 *  2. a straight climb-out past the runway end;
 *  3. a Dubins curve (shortest path with a minimum turn radius) to the final
 *     approach fix, lined up with the destination runway, landing into the wind;
 *  4. a straight-in final on a 4° glide slope to the aiming point, then the rollout.
 * The height profile clears the terrain under and beside the path, with limits
 * on climb and descent gradients, and is smoothed so it flies like a plan.
 */

export interface TerrainLike {
  height(x: number, z: number): number;
}

export interface RoutePoint {
  x: number;
  y: number;
  z: number;
  /** distance along the path from the take-off point (m) */
  s: number;
}

export interface Route {
  from: Airfield;
  to: Airfield;
  pts: RoutePoint[];
  length: number;
  /** take-off direction at the home field (into the wind) */
  depart: { dx: number; dz: number };
  /** landing direction at the destination (into the wind) */
  land: { dx: number; dz: number };
  /** where the wheels should leave the runway / touch down */
  sLift: number;
  sAim: number;
  /** where the straight-in final begins */
  sFinal: number;
  turnRadius: number;
  maxAlt: number;
  /** climb-out and final gradients actually used (steeper than CLIMB / GLIDE only where the terrain forces it) */
  climb: number;
  glide: number;
}

/** Glide slope, matching the HUD landing advice (≈4°). */
export const GLIDE = Math.tan((4 * Math.PI) / 180);
export const CLIMB = 0.08;
const STEP = 20;
const LIFT = 350; // m down the runway where the path leaves the ground
const CLIMB_OUT = 800; // straight climb past the runway end
const FINAL = 3000; // straight-in final, measured back from the aiming point
const AIM = 150; // aiming point past the landing threshold
const ROLLOUT = 350;
const GEAR_H = 2.5; // path height over the runway (about where the plane sits)
const CLEAR = 120; // cruise clearance over the highest terrain near the path
const SAFE = 60; // never closer to the terrain than this, away from the runways
const CRUISE_MIN = 200; // cruise at least this far above the higher airfield

/** Runway direction that points into the wind (take off and land into it). */
export function runwayDir(af: Airfield, wind: { x: number; z: number }): { dx: number; dz: number } {
  if (wind.x * af.dirX + wind.z * af.dirZ > 0) return { dx: -af.dirX, dz: -af.dirZ };
  return { dx: af.dirX, dz: af.dirZ };
}

const COMPASS = ['North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest'];

/** Bearing in degrees (0 = north = −z, 90 = east = +x), as on the HUD compass. */
export function bearing(fx: number, fz: number, tx: number, tz: number): number {
  return ((Math.atan2(tx - fx, -(tz - fz)) * 180) / Math.PI + 360) % 360;
}

/** Names for every airfield: "Home Field", then by compass bearing from home. */
export function airfieldNames(fields: Airfield[]): string[] {
  const home = fields[0];
  const names = fields.map((af, i) => {
    if (i === 0) return 'Home Field';
    const b = bearing(home.x, home.z, af.x, af.z);
    return `${COMPASS[Math.round(b / 45) % 8]} Field`;
  });
  // two fields in the same direction: the farther one is "Far …"
  for (let i = 1; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      if (names[i] === names[j]) {
        const di = Math.hypot(fields[i].x - home.x, fields[i].z - home.z);
        const dj = Math.hypot(fields[j].x - home.x, fields[j].z - home.z);
        if (di > dj) names[i] = `Far ${names[i]}`;
        else names[j] = `Far ${names[j]}`;
      }
  return names;
}

/** Turn radius the route is planned for, by airframe (gentle banks at cruise speed). */
export const TURN_RADIUS: Record<string, number> = { biplane: 700, turboprop: 1000, jet: 1500 };
/** Typical cruise speed (m/s), for the menu's time estimate. */
export const CRUISE_SPEED: Record<string, number> = { biplane: 44, turboprop: 72, jet: 115 };

// ------------------------------------------------------------------ Dubins

type Seg = 'L' | 'S' | 'R';
interface Pose {
  x: number;
  z: number;
  h: number; // heading: atan2(dz, dx)
}

const TAU = Math.PI * 2;
const mod = (a: number) => ((a % TAU) + TAU) % TAU;

/** Candidate CSC Dubins words as normalised lengths [t, p, q] (radius 1). */
function dubinsWords(a: number, b: number, d: number): [Seg[], number, number, number][] {
  const sa = Math.sin(a);
  const sb = Math.sin(b);
  const ca = Math.cos(a);
  const cb = Math.cos(b);
  const cab = Math.cos(a - b);
  const out: [Seg[], number, number, number][] = [];
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
    if (p2 >= 0) {
      const tmp = Math.atan2(cb - ca, d + sa - sb);
      out.push([['L', 'S', 'L'], mod(-a + tmp), Math.sqrt(p2), mod(b - tmp)]);
    }
  }
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
    if (p2 >= 0) {
      const tmp = Math.atan2(ca - cb, d - sa + sb);
      out.push([['R', 'S', 'R'], mod(a - tmp), Math.sqrt(p2), mod(-b + tmp)]);
    }
  }
  {
    const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
      out.push([['L', 'S', 'R'], mod(-a + tmp), p, mod(-b + tmp)]);
    }
  }
  {
    const p2 = d * d - 2 + 2 * cab - 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
      out.push([['R', 'S', 'L'], mod(a - tmp), p, mod(b - tmp)]);
    }
  }
  return out;
}

/** Walk a Dubins word from `start`, emitting a point every `step` metres (exact arcs). */
function walk(start: Pose, word: Seg[], lens: number[], r: number, step: number, emit?: (x: number, z: number) => void): Pose {
  let { x, z, h } = start;
  for (let k = 0; k < 3; k++) {
    const len = lens[k] * r;
    const n = Math.max(1, Math.ceil(len / step));
    const ds = len / n;
    for (let i = 0; i < n; i++) {
      if (word[k] === 'S') {
        x += Math.cos(h) * ds;
        z += Math.sin(h) * ds;
      } else {
        const phi = (ds / r) * (word[k] === 'L' ? 1 : -1);
        const chord = 2 * r * Math.sin(Math.abs(phi) / 2);
        const mid = h + phi / 2;
        x += Math.cos(mid) * chord;
        z += Math.sin(mid) * chord;
        h += phi;
      }
      emit?.(x, z);
    }
  }
  return { x, z, h };
}

/** Shortest curvature-bounded path between two poses, sampled every `step` m (start excluded). */
export function dubins(a: Pose, b: Pose, r: number, step = STEP): { x: number; z: number }[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.hypot(dx, dz) / r;
  const th = Math.atan2(dz, dx);
  const al = mod(a.h - th);
  const be = mod(b.h - th);
  let best: { word: Seg[]; lens: number[]; len: number } | null = null;
  for (const [word, t, p, q] of dubinsWords(al, be, d)) {
    const len = t + p + q;
    if (best && len >= best.len) continue;
    // check the word really ends at b (guards against any sign slip in the formulas)
    const end = walk(a, word, [t, p, q], r, 50);
    if (Math.hypot(end.x - b.x, end.z - b.z) > 2 || Math.abs(Math.sin((end.h - b.h) / 2)) > 0.01) continue;
    best = { word, lens: [t, p, q], len };
  }
  const pts: { x: number; z: number }[] = [];
  if (!best) {
    // cannot happen for valid input; fall back to a straight line
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step));
    for (let i = 1; i <= n; i++) pts.push({ x: a.x + (dx * i) / n, z: a.z + (dz * i) / n });
    return pts;
  }
  walk(a, best.word, best.lens, r, step, (x, z) => pts.push({ x, z }));
  pts[pts.length - 1] = { x: b.x, z: b.z };
  return pts;
}

// ------------------------------------------------------------------ planner

/**
 * Plan the route. Several candidates are built (each runway direction at both
 * ends, short and long climb-out); the shortest one that clears the terrain
 * wins, preferring to take off and land into the wind.
 */
export function planRoute(gen: TerrainLike, from: Airfield, to: Airfield, wind: { x: number; z: number }, turnRadius = 700): Route {
  const depW = runwayDir(from, wind);
  const arrW = runwayDir(to, wind);
  const flip = (d: { dx: number; dz: number }) => ({ dx: -d.dx, dz: -d.dz });
  // a downwind take-off or landing costs DOWNWIND metres of extra flying per m/s of tailwind
  const tail = Math.hypot(wind.x, wind.z) * DOWNWIND;
  let best: { r: Route; score: number } | null = null;
  for (const [dep, depPen] of [
    [depW, 0],
    [flip(depW), tail],
  ] as const)
    for (const [arr, arrPen] of [
      [arrW, 0],
      [flip(arrW), tail],
    ] as const)
      for (const climbOut of [CLIMB_OUT, 300]) {
        const c = buildRoute(gen, from, to, dep, arr, climbOut, turnRadius);
        // steeper than planned costs a little; steeper than 0.1 (≈6°) a lot
        const steep = c.violation * 40000 + (Math.max(0, c.r.climb - 0.1) + Math.max(0, c.r.glide - 0.1)) * 400000;
        const score = c.r.length + depPen + arrPen + (climbOut === CLIMB_OUT ? 0 : 300) + steep;
        if (!best || score < best.score) best = { r: c.r, score };
      }
  return best!.r;
}

/** Extra cost (m per m/s of tailwind) for a downwind take-off or landing. */
const DOWNWIND = 1800;

function buildRoute(
  gen: TerrainLike,
  from: Airfield,
  to: Airfield,
  dep: { dx: number; dz: number },
  arr: { dx: number; dz: number },
  climbOut: number,
  turnRadius: number,
): { r: Route; violation: number } {
  const ground = (x: number, z: number) => Math.max(gen.height(x, z), 0);

  // horizontal path
  const xz: { x: number; z: number }[] = [];
  const line = (ax: number, az: number, bx: number, bz: number, first: boolean) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP));
    for (let i = first ? 0 : 1; i <= n; i++) xz.push({ x: ax + ((bx - ax) * i) / n, z: az + ((bz - az) * i) / n });
  };
  const back = from.paved / 2 - 20; // same line-up spot as the sortie start
  const t0x = from.x - dep.dx * back;
  const t0z = from.z - dep.dz * back;
  const p1x = from.x + dep.dx * (from.paved / 2 + climbOut);
  const p1z = from.z + dep.dz * (from.paved / 2 + climbOut);
  const thx = to.x - arr.dx * (to.paved / 2);
  const thz = to.z - arr.dz * (to.paved / 2);
  const aimX = thx + arr.dx * AIM;
  const aimZ = thz + arr.dz * AIM;
  const fafX = aimX - arr.dx * FINAL;
  const fafZ = aimZ - arr.dz * FINAL;
  line(t0x, t0z, p1x, p1z, true);
  for (const p of dubins({ x: p1x, z: p1z, h: Math.atan2(dep.dz, dep.dx) }, { x: fafX, z: fafZ, h: Math.atan2(arr.dz, arr.dx) }, turnRadius)) xz.push(p);
  const iFinal = xz.length - 1;
  line(fafX, fafZ, aimX, aimZ, false);
  const iAim = xz.length - 1;
  line(aimX, aimZ, aimX + arr.dx * ROLLOUT, aimZ + arr.dz * ROLLOUT, false);

  const n = xz.length;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(xz[i].x - xz[i - 1].x, xz[i].z - xz[i - 1].z);
  const sLift = LIFT;
  const sAim = s[iAim];
  const sFinal = s[iFinal];

  // terrain under the path: highest ground under and beside it, then a running max along it
  const under = new Float64Array(n);
  const side = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.min(n - 1, i + 1);
    const k = Math.max(0, i - 1);
    let tx = xz[j].x - xz[k].x;
    let tz = xz[j].z - xz[k].z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    under[i] = ground(xz[i].x, xz[i].z);
    let m = under[i];
    for (const o of [-200, -100, 100, 200]) m = Math.max(m, ground(xz[i].x - tz * o, xz[i].z + tx * o));
    side[i] = m;
  }
  const W = Math.round(200 / STEP);
  const hiNear = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) m = Math.max(m, side[k]);
    hiNear[i] = m;
  }

  // Two floors. Hard: the terrain plus a safety margin (ramped near the runways).
  // Soft: a sensible cruise with more clearance over the hills. The hard floor sets
  // how steep the climb-out (`climb`) and the final (`glide`) must be; the soft one
  // is only followed as far as the CLIMB / GLIDE gradients allow.
  const fromH = from.height + GEAR_H;
  const toH = to.height + GEAR_H;
  const sRunEnd = back + from.paved / 2;
  const sThreshold = sAim - AIM;
  const cruise = Math.max(from.height, to.height) + CRUISE_MIN;
  const hard = new Float64Array(n);
  const soft = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (s[i] <= sLift) hard[i] = soft[i] = fromH;
    else if (s[i] >= sAim) hard[i] = soft[i] = toH;
    else {
      const inside = s[i] > sRunEnd && s[i] < sThreshold;
      const safe = inside ? Math.min(SAFE, 10 + (s[i] - sRunEnd) * CLIMB * 0.6, 10 + (sThreshold - s[i]) * GLIDE * 0.6) : 0;
      hard[i] = under[i] + safe;
      soft[i] = Math.max(hard[i], hiNear[i] + CLEAR, cruise);
    }
  }
  // gradients the hard floor needs from the lift-off point and down to the aiming point
  let climb = CLIMB;
  let glide = GLIDE;
  for (let i = 0; i < n; i++) {
    if (s[i] > sLift + 1) climb = Math.max(climb, (hard[i] - fromH) / (s[i] - sLift));
    if (s[i] < sAim - 1) glide = Math.max(glide, (hard[i] - toH) / (sAim - s[i]));
  }
  // lowest profile above a floor that climbs no steeper than `c` and descends no steeper than `d`
  const envelope = (req: Float64Array, c: number, d: number) => {
    const yb = new Float64Array(n);
    const yf = new Float64Array(n);
    yb[n - 1] = req[n - 1];
    for (let i = n - 2; i >= 0; i--) yb[i] = Math.max(req[i], yb[i + 1] - c * (s[i + 1] - s[i]));
    yf[0] = req[0];
    for (let i = 1; i < n; i++) yf[i] = Math.max(req[i], yf[i - 1] - d * (s[i] - s[i - 1]));
    for (let i = 0; i < n; i++) yb[i] = Math.max(yb[i], yf[i]);
    return yb;
  };
  const envHard = envelope(hard, climb, glide);
  const envSoft = envelope(soft, CLIMB, GLIDE);
  // smooth the cruise corners (never below the envelope)
  const SW = Math.round(300 / STEP);
  const pts: RoutePoint[] = [];
  let maxAlt = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let k = Math.max(0, i - SW); k <= Math.min(n - 1, i + SW); k++) {
      sum += envSoft[k];
      c++;
    }
    const smooth = Math.max(envSoft[i], sum / c);
    // the climb-out and the final are straight lines from / to the runway
    const ceilDep = fromH + Math.max(0, s[i] - sLift) * climb;
    const ceilArr = toH + Math.max(0, sAim - s[i]) * glide;
    const y = Math.max(Math.min(smooth, ceilDep, ceilArr), envHard[i]);
    maxAlt = Math.max(maxAlt, y);
    pts.push({ x: xz[i].x, y, z: xz[i].z, s: s[i] });
  }
  // how much steeper than planned the climb-out or final had to be
  const violation = Math.max(0, climb - CLIMB) + Math.max(0, glide - GLIDE);
  return { r: { from, to, pts, length: s[n - 1], depart: dep, land: arr, sLift, sAim, sFinal, turnRadius, maxAlt, climb, glide }, violation };
}

/** Point on the route at distance `d` along it (clamped). */
export function pointAt(r: Route, d: number, out: { x: number; y: number; z: number }) {
  const pts = r.pts;
  if (d <= 0) return Object.assign(out, { x: pts[0].x, y: pts[0].y, z: pts[0].z });
  if (d >= r.length) {
    const p = pts[pts.length - 1];
    return Object.assign(out, { x: p.x, y: p.y, z: p.z });
  }
  // binary search for the segment
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].s <= d) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const t = (d - a.s) / (b.s - a.s || 1);
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/**
 * Tracks the plane's progress along a route: the nearest path point, searched
 * forward from the last one so the progress never jumps back to an earlier leg.
 */
export class RouteTracker {
  idx = 0;
  /** distance along the route of the nearest point */
  progress = 0;
  /** horizontal and vertical offset from the path (m) */
  lateral = 0;
  vertical = 0;

  constructor(readonly route: Route) {}

  update(x: number, y: number, z: number) {
    const pts = this.route.pts;
    const scan = (from: number, to: number) => {
      let best = -1;
      let bd = Infinity;
      for (let i = Math.max(0, from); i <= Math.min(pts.length - 1, to); i++) {
        const p = pts[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2 + ((p.y - y) * 2) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return { best, bd };
    };
    let r = scan(this.idx - 5, this.idx + 150);
    // far off the path (or the plane was moved): look along the rest of it
    if (r.bd > 1500 * 1500) {
      const all = scan(this.idx - 5, pts.length - 1);
      if (all.bd < r.bd) r = all;
    }
    if (r.best >= 0) this.idx = r.best;
    const p = pts[this.idx];
    this.progress = p.s;
    this.lateral = Math.hypot(p.x - x, p.z - z);
    this.vertical = y - p.y;
  }

  /** Close enough to count as following the path. */
  onPath(): boolean {
    return this.lateral < 150 && Math.abs(this.vertical) < 70;
  }
}
