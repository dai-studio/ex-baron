import type { Airfield } from '../world/terrain';
import { dubins, runwayDir, type RoutePoint, type TerrainLike } from './route';
import { GLYPHS, type Pt } from './skyfont';

/**
 * Skywriting planner (plan step 52). Pure and three-free so it can be tested
 * headless and drawn on the menu before the sortie.
 *
 * The message lies flat in the sky at one altitude, readable from above, out
 * past the home field's runway. Text space is (u, v) in metres: u to the right
 * along the line of text, v up the letters (away from the home field), the
 * baseline of the first letter at u = 0, v = 0.
 *
 * The flight path: a straight approach, then for every stroke a straight
 * lead-in, the stroke itself (smoke on), a short lead-out and a Dubins
 * connector at the writing turn radius to the next stroke's lead-in (smoke
 * off). Strokes are split at sharp corners, as real skywriters lift the smoke
 * there and loop round onto the new heading.
 */

export interface UV {
  u: number;
  v: number;
}

export interface SmokeSeg {
  s0: number;
  s1: number;
  /** first and last index into pts / uv */
  i0: number;
  i1: number;
  /** index into SkyPlan.letters */
  letter: number;
}

export interface SkyLetter {
  ch: string;
  u0: number;
  u1: number;
}

export interface SkyPlan {
  message: string;
  letters: SkyLetter[];
  /** letter (cap) height, m */
  H: number;
  /** turn radius the strokes and connectors are planned for, m */
  radius: number;
  /** writing altitude (m above sea level) */
  alt: number;
  /** text width (u extent), m */
  width: number;
  /** world position of text-space (0, 0) and the world directions of +u and +v */
  origin: { x: number; z: number };
  right: { x: number; z: number };
  up: { x: number; z: number };
  /** the whole flight path, every STEP m, at the writing altitude */
  pts: RoutePoint[];
  /** path in text space, same indices as pts */
  uv: UV[];
  length: number;
  /** stretches of the path where the smoke should be on, in path order */
  smoke: SmokeSeg[];
  /** the letter strokes in text space (after corner splitting) */
  strokes: { letter: number; pts: UV[] }[];
  /** points along the strokes every 2% of H, for scoring */
  targets: (UV & { letter: number })[];
  /** where the writing is done: just after the last stroke's lead-out */
  end: number;
}

const STEP = 10;
/** corners sharper than this split a stroke (radians) */
const CORNER = (35 * Math.PI) / 180;
/** letter height in turn radii */
export const H_PER_RADIUS = 4.5;
/** connectors (smoke off) may turn a little tighter than the strokes */
export const CONNECT_RADIUS = 0.8;
const LETTER_GAP = 0.3; // em between letters
const WORD_GAP = 0.8; // em for a space
const LEAD_IN = 0.2; // em of straight flight before each stroke
const LEAD_OUT = 0.08; // em after it
const APPROACH = 900; // m of straight flight from the start to the first lead-in
const CLEARANCE = 950; // m over the highest ground under the writing (above the cloud tops)
const OUT = 800; // m from the home field to the baseline

/** Writing speed: about where the planes sit at 60–70% throttle. */
export function writingSpeed(stallSpeed: number): number {
  return stallSpeed * 2;
}

/** Writing turn radius from the clean stall speed: the writing speed in a 50° bank. */
export function writingRadius(stallSpeed: number): number {
  const v = writingSpeed(stallSpeed);
  return (v * v) / (9.81 * Math.tan((50 * Math.PI) / 180));
}

/** Split a polyline at corners sharper than CORNER. */
export function splitCorners(pts: Pt[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    cur.push(pts[i]);
    if (i < pts.length - 1) {
      const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
      const turn = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
      if (turn > CORNER) {
        out.push(cur);
        cur = [pts[i]];
      }
    }
  }
  out.push(cur);
  return out.filter((s) => s.length >= 2);
}

/** Resample a polyline at even spacing of at most `step` (start and end kept). */
function resample(pts: UV[], step: number): UV[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].u - pts[i - 1].u, pts[i].v - pts[i - 1].v));
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.ceil(total / step));
  const out: UV[] = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const d = (total * k) / n;
    while (j < pts.length - 1 && cum[j] < d) j++;
    const a = pts[j - 1];
    const b = pts[j];
    const t = (d - cum[j - 1]) / (cum[j] - cum[j - 1] || 1);
    out.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
  }
  return out;
}

const headingOf = (a: UV, b: UV) => Math.atan2(b.v - a.v, b.u - a.u);

function pathLength(p: { x: number; z: number }[], from: { x: number; z: number }): number {
  let len = 0;
  let q = from;
  for (const r of p) {
    len += Math.hypot(r.x - q.x, r.z - q.z);
    q = r;
  }
  return len;
}

/** Lay out the message: strokes in text space (metres) per letter. */
export function layoutMessage(message: string, H: number): { letters: SkyLetter[]; strokes: { letter: number; pts: UV[] }[]; width: number } {
  const letters: SkyLetter[] = [];
  const strokes: { letter: number; pts: UV[] }[] = [];
  let u = 0;
  let first = true;
  for (const ch of message) {
    if (ch === ' ') {
      u += WORD_GAP * H;
      first = true;
      continue;
    }
    const g = GLYPHS[ch];
    if (!g) continue;
    if (!first) u += LETTER_GAP * H;
    first = false;
    const li = letters.length;
    letters.push({ ch, u0: u, u1: u + g.w * H });
    for (const s of g.strokes)
      for (const part of splitCorners(s)) strokes.push({ letter: li, pts: part.map(([x, y]) => ({ u: u + x * H, v: y * H })) });
    u += g.w * H;
  }
  return { letters, strokes, width: u };
}

/**
 * Plan the skywriting flight for a message. `radius` is the writing turn radius
 * (see writingRadius); the letters are H_PER_RADIUS radii tall.
 */
export function planSkywriting(gen: TerrainLike, home: Airfield, message: string, radius: number, wind: { x: number; z: number }): SkyPlan {
  const H = radius * H_PER_RADIUS;
  const { letters, strokes, width } = layoutMessage(message, H);
  // out past the runway (into the wind), centred on the home field
  const d = runwayDir(home, wind);
  const up = { x: d.dx, z: d.dz };
  const right = { x: -d.dz, z: d.dx };
  const origin = { x: home.x + up.x * OUT - right.x * (width / 2), z: home.z + up.z * OUT - right.z * (width / 2) };
  const toWorld = (p: UV) => ({ x: origin.x + right.x * p.u + up.x * p.v, z: origin.z + right.z * p.u + up.z * p.v });

  // the path, in text space
  const uv: UV[] = [];
  const smoke: SmokeSeg[] = [];
  const len = () => {
    let s = 0;
    for (let i = 1; i < uv.length; i++) s += Math.hypot(uv[i].u - uv[i - 1].u, uv[i].v - uv[i - 1].v);
    return s;
  };
  let sAcc = 0;
  const push = (p: UV) => {
    const l = uv[uv.length - 1];
    if (l) {
      const d2 = Math.hypot(p.u - l.u, p.v - l.v);
      if (d2 < 0.01) return;
      sAcc += d2;
    }
    uv.push({ u: p.u, v: p.v });
  };
  const line = (a: UV, b: UV) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.u - a.u, b.v - a.v) / STEP));
    for (let i = 0; i <= n; i++) push({ u: a.u + ((b.u - a.u) * i) / n, v: a.v + ((b.v - a.v) * i) / n });
  };
  const leadInStart = (s: UV[]) => {
    const h = headingOf(s[0], s[1]);
    return { u: s[0].u - Math.cos(h) * LEAD_IN * H, v: s[0].v - Math.sin(h) * LEAD_IN * H, h };
  };

  let pose: { u: number; v: number; h: number } | null = null;
  const remaining = strokes.map((s, i) => ({ ...s, i }));
  let end = 0;
  for (let li = 0; li < letters.length; li++) {
    let left = remaining.filter((s) => s.letter === li);
    while (left.length) {
      // pick the stroke (and direction) with the shortest connector from here
      let best: { k: number; pts: UV[]; cost: number } | null = null;
      for (let k = 0; k < left.length; k++)
        for (const rev of [false, true]) {
          const pts = rev ? [...left[k].pts].reverse() : left[k].pts;
          let cost: number;
          if (!pose) cost = k + (rev ? 0.5 : 0); // the first stroke as drawn
          else {
            const li0 = leadInStart(pts);
            const c = dubins({ x: pose.u, z: pose.v, h: pose.h }, { x: li0.u, z: li0.v, h: li0.h }, radius * CONNECT_RADIUS, 40);
            cost = pathLength(c, { x: pose.u, z: pose.v });
          }
          if (!best || cost < best.cost) best = { k, pts, cost };
        }
      const s = resample(best!.pts, STEP);
      const li0 = leadInStart(s);
      if (!pose) {
        // straight approach to the first lead-in
        line({ u: li0.u - Math.cos(li0.h) * APPROACH, v: li0.v - Math.sin(li0.h) * APPROACH }, li0);
      } else {
        for (const p of dubins({ x: pose.u, z: pose.v, h: pose.h }, { x: li0.u, z: li0.v, h: li0.h }, radius * CONNECT_RADIUS, STEP)) push({ u: p.x, v: p.z });
      }
      line(li0, s[0]);
      const s0 = sAcc;
      const i0 = uv.length - 1;
      for (const p of s) push(p);
      smoke.push({ s0, s1: sAcc, i0, i1: uv.length - 1, letter: li });
      const hEnd = headingOf(s[s.length - 2], s[s.length - 1]);
      const last = s[s.length - 1];
      const out = { u: last.u + Math.cos(hEnd) * LEAD_OUT * H, v: last.v + Math.sin(hEnd) * LEAD_OUT * H };
      line(last, out);
      end = sAcc;
      pose = { ...out, h: hEnd };
      left = left.filter((_, k) => k !== best!.k);
    }
  }
  // a little straight flight after the end, so the path doesn't stop dead
  if (pose) line(pose, { u: pose.u + Math.cos(pose.h) * 600, v: pose.v + Math.sin(pose.h) * 600 });

  // altitude: well clear of the highest ground under the path and the text
  let hi = Math.max(home.height, 0);
  for (let i = 0; i < uv.length; i += 3) {
    const w = toWorld(uv[i]);
    hi = Math.max(hi, gen.height(w.x, w.z));
  }
  for (let u = -radius * 2; u <= width + radius * 2; u += 150)
    for (let v = -radius * 2; v <= H + radius * 2; v += 150) {
      const w = toWorld({ u, v });
      hi = Math.max(hi, gen.height(w.x, w.z));
    }
  const alt = hi + CLEARANCE;

  const pts: RoutePoint[] = [];
  let s = 0;
  for (let i = 0; i < uv.length; i++) {
    if (i) s += Math.hypot(uv[i].u - uv[i - 1].u, uv[i].v - uv[i - 1].v);
    const w = toWorld(uv[i]);
    pts.push({ x: w.x, y: alt, z: w.z, s });
  }
  const length = len();

  const targets: (UV & { letter: number })[] = [];
  for (const st of strokes) for (const p of resample(st.pts, H * 0.02)) targets.push({ ...p, letter: st.letter });

  return { message, letters, H, radius, alt, width, origin, right, up, pts, uv, length, smoke, strokes, targets, end };
}

/** World x/z to text space. */
export function toText(plan: SkyPlan, x: number, z: number): UV {
  const dx = x - plan.origin.x;
  const dz = z - plan.origin.z;
  return { u: dx * plan.right.x + dz * plan.right.z, v: dx * plan.up.x + dz * plan.up.z };
}

/** Text space to world x/z. */
export function toWorld(plan: SkyPlan, p: UV): { x: number; z: number } {
  return { x: plan.origin.x + plan.right.x * p.u + plan.up.x * p.v, z: plan.origin.z + plan.right.z * p.u + plan.up.z * p.v };
}

// ------------------------------------------------------------------ tracker

/**
 * Progress along the skywriting path. The path loops back over itself (every
 * corner is a loop), so the nearest point is only searched a little ahead of
 * the last one; if the plane is far off, a wider search ahead that also
 * matches the heading picks the path up again. Progress never goes backwards
 * by more than a step or two.
 */
export class SkyTracker {
  idx = 0;
  progress = 0;
  lateral = 0;
  vertical = 0;

  constructor(readonly plan: { pts: RoutePoint[] }) {}

  update(x: number, y: number, z: number, hx: number, hz: number) {
    const pts = this.plan.pts;
    const n = pts.length;
    let best = this.idx;
    let bd = Infinity;
    for (let i = Math.max(0, this.idx - 2); i <= Math.min(n - 1, this.idx + 12); i++) {
      const d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (bd > 250 * 250) {
      // lost: look ahead for a stretch near the plane that runs the same way
      let wb = -1;
      let wc = Infinity;
      const hl = Math.hypot(hx, hz) || 1;
      for (let i = this.idx; i <= Math.min(n - 2, this.idx + 800); i++) {
        const d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2;
        if (d > 400 * 400) continue;
        const tx = pts[i + 1].x - pts[i].x;
        const tz = pts[i + 1].z - pts[i].z;
        const cos = (tx * hx + tz * hz) / ((Math.hypot(tx, tz) || 1) * hl);
        if (cos < 0.5) continue;
        const c = d * (2 - cos);
        if (c < wc) {
          wc = c;
          wb = i;
        }
      }
      if (wb >= 0) best = wb;
    }
    this.idx = best;
    const p = pts[best];
    this.progress = p.s;
    this.lateral = Math.hypot(p.x - x, p.z - z);
    this.vertical = y - p.y;
  }
}

// ------------------------------------------------------------------ cues

export interface SkyCue {
  /** on: smoke now; soon: a smoke segment is coming up; off: between strokes; done: all written */
  state: 'on' | 'soon' | 'off' | 'done';
  /** the current or next smoke segment */
  seg: number;
  /** metres to the start (soon / off) or end (on) of that segment */
  dist: number;
}

export function skyCue(plan: SkyPlan, progress: number): SkyCue {
  for (let i = 0; i < plan.smoke.length; i++) {
    const sg = plan.smoke[i];
    if (progress > sg.s1) continue;
    if (progress >= sg.s0) return { state: 'on', seg: i, dist: sg.s1 - progress };
    const dist = sg.s0 - progress;
    return { state: dist < 300 ? 'soon' : 'off', seg: i, dist };
  }
  return { state: 'done', seg: plan.smoke.length, dist: 0 };
}

// ------------------------------------------------------------------ scoring

export interface SmokePoint {
  u: number;
  v: number;
  /** height above (+) or below (−) the writing altitude */
  dy: number;
}

export interface SkyScore {
  /** 0..100 */
  score: number;
  /** share of the letters drawn 0..1 */
  coverage: number;
  /** share of the smoke that is on a letter 0..1 */
  neatness: number;
  letters: { ch: string; score: number }[];
  grade: string;
  medal: number;
}

/** Points in a uniform grid for nearest-neighbour lookups within a radius. */
class Grid {
  private cells = new Map<string, number[]>();
  constructor(
    private pts: UV[],
    private cell: number,
  ) {
    pts.forEach((p, i) => {
      const k = `${Math.floor(p.u / cell)},${Math.floor(p.v / cell)}`;
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
    });
  }
  /** nearest point within `cell` (or Infinity) and its index */
  nearest(p: UV): { d: number; i: number } {
    const cx = Math.floor(p.u / this.cell);
    const cz = Math.floor(p.v / this.cell);
    let d = Infinity;
    let bi = -1;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const c = this.cells.get(`${cx + i},${cz + j}`);
        if (!c) continue;
        for (const k of c) {
          const q = this.pts[k];
          const dd = Math.hypot(q.u - p.u, q.v - p.v);
          if (dd < d) {
            d = dd;
            bi = k;
          }
        }
      }
    return { d, i: bi };
  }
}

/** Tolerance for the score, as a share of the letter height. */
export const SCORE_TOL = 0.05;

export function gradeFor(score: number): string {
  return score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D';
}

export function medalFor(score: number): number {
  return score >= 85 ? 3 : score >= 70 ? 2 : score >= 50 ? 1 : 0;
}

/**
 * Score the writing: coverage (how much of each letter has smoke on it) times
 * neatness (how much of the smoke is on a letter). Smoke far above or below
 * the writing altitude counts as stray.
 */
export function scoreWriting(plan: SkyPlan, smoke: SmokePoint[]): SkyScore {
  const T = plan.H * SCORE_TOL;
  const credit = (d: number) => (d <= T ? 1 : d >= 2.5 * T ? 0 : 1 - (d - T) / (1.5 * T));
  const band = plan.H * 0.3;
  const good = smoke.filter((p) => Math.abs(p.dy) < band);
  const smokeGrid = new Grid(good, 2.5 * T);
  const targetGrid = new Grid(plan.targets, 2.5 * T);
  const n = plan.letters.length;
  const cov = new Float64Array(n);
  const covN = new Float64Array(n);
  const neat = new Float64Array(n);
  const neatN = new Float64Array(n);
  let covSum = 0;
  for (const t of plan.targets) {
    const c = good.length ? credit(smokeGrid.nearest(t).d) : 0;
    covSum += c;
    cov[t.letter] += c;
    covN[t.letter]++;
  }
  let neatSum = 0;
  for (const p of smoke) {
    const near = Math.abs(p.dy) < band ? targetGrid.nearest(p) : { d: Infinity, i: -1 };
    const c = credit(near.d);
    neatSum += c;
    // stray smoke counts against the nearest letter along the line
    let li = near.i >= 0 ? plan.targets[near.i].letter : -1;
    if (li < 0) {
      let bd = Infinity;
      plan.letters.forEach((l, k) => {
        const d = p.u < l.u0 ? l.u0 - p.u : p.u > l.u1 ? p.u - l.u1 : 0;
        if (d < bd) {
          bd = d;
          li = k;
        }
      });
    }
    if (li >= 0) {
      neat[li] += c;
      neatN[li]++;
    }
  }
  const coverage = plan.targets.length ? covSum / plan.targets.length : 0;
  const neatness = smoke.length ? neatSum / smoke.length : 0;
  const total = (c: number, ne: number) => Math.round(100 * c * (0.4 + 0.6 * ne));
  const score = total(coverage, neatness);
  const letters = plan.letters.map((l, k) => ({ ch: l.ch, score: total(covN[k] ? cov[k] / covN[k] : 0, neatN[k] ? neat[k] / neatN[k] : 0) }));
  return { score, coverage, neatness, letters, grade: gradeFor(score), medal: medalFor(score) };
}
