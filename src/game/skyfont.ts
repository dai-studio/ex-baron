/**
 * Single-stroke skywriting font (plan step 52). Each glyph is a width and a list
 * of strokes, each stroke a polyline in em units (x right, y up, baseline 0, cap
 * height 1). Curves are elliptical arcs with a radius of curvature of at least
 * about 0.2 em, so a plane that turns in 1/5 of the letter height can fly them.
 * Sharp corners are fine: the planner splits strokes there (the smoke goes off,
 * the plane loops round and comes back in on the new heading).
 */
export type Pt = [number, number];
export interface Glyph {
  w: number;
  strokes: Pt[][];
}

/** Arc of an ellipse from a0 to a1 (degrees, either direction), sampled every 2°. */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Pt[] {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 2));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/** Join pieces into one stroke, dropping a repeated joint point. */
function join(...parts: Pt[][]): Pt[] {
  const out: Pt[] = [];
  for (const p of parts)
    for (const q of p) {
      const l = out[out.length - 1];
      if (l && Math.hypot(l[0] - q[0], l[1] - q[1]) < 1e-6) continue;
      out.push(q);
    }
  return out;
}

const L = (...pts: number[]): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push([pts[i], pts[i + 1]]);
  return out;
};

/** a short dash for a dot (a puff or two of smoke) */
const dot = (x: number): Pt[] => L(x, 0.07, x, 0);

const bowl = (top: number, bottom: number, x = 0.3) => {
  const r = (top - bottom) / 2;
  return join(L(0, top, x, top), arc(x, top - r, r, r, 90, -90), L(x, bottom, 0, bottom));
};

export const GLYPHS: Record<string, Glyph> = {
  A: { w: 0.7, strokes: [L(0, 0, 0.35, 1), L(0.35, 1, 0.7, 0), L(0.14, 0.4, 0.56, 0.4)] },
  B: { w: 0.6, strokes: [L(0, 0, 0, 1), bowl(1, 0.5, 0.3), bowl(0.5, 0, 0.32)] },
  C: { w: 0.7, strokes: [arc(0.4, 0.5, 0.4, 0.5, 50, 310)] },
  D: { w: 0.65, strokes: [L(0, 0, 0, 1), join(L(0, 1, 0.15, 1), arc(0.15, 0.5, 0.5, 0.5, 90, -90), L(0.15, 0, 0, 0))] },
  E: { w: 0.55, strokes: [L(0.55, 1, 0, 1, 0, 0, 0.55, 0), L(0, 0.5, 0.45, 0.5)] },
  F: { w: 0.55, strokes: [L(0.55, 1, 0, 1, 0, 0), L(0, 0.5, 0.45, 0.5)] },
  G: { w: 0.8, strokes: [join(arc(0.4, 0.5, 0.4, 0.5, 50, 360), L(0.8, 0.5, 0.45, 0.5))] },
  H: { w: 0.6, strokes: [L(0, 0, 0, 1), L(0.6, 0, 0.6, 1), L(0, 0.5, 0.6, 0.5)] },
  I: { w: 0, strokes: [L(0, 1, 0, 0)] },
  J: { w: 0.5, strokes: [join(L(0.5, 1, 0.5, 0.3), arc(0.25, 0.3, 0.25, 0.3, 0, -180))] },
  K: { w: 0.6, strokes: [L(0, 0, 0, 1), L(0.6, 1, 0, 0.4), L(0.22, 0.62, 0.6, 0)] },
  L: { w: 0.55, strokes: [L(0, 1, 0, 0, 0.55, 0)] },
  M: { w: 0.8, strokes: [L(0, 0, 0, 1, 0.4, 0.4, 0.8, 1, 0.8, 0)] },
  N: { w: 0.65, strokes: [L(0, 0, 0, 1, 0.65, 0, 0.65, 1)] },
  O: { w: 0.7, strokes: [arc(0.35, 0.5, 0.35, 0.5, 90, 450)] },
  P: { w: 0.55, strokes: [L(0, 0, 0, 1), bowl(1, 0.5, 0.3)] },
  Q: { w: 0.75, strokes: [arc(0.35, 0.5, 0.35, 0.5, 90, 450), L(0.45, 0.25, 0.75, -0.05)] },
  R: { w: 0.6, strokes: [L(0, 0, 0, 1), bowl(1, 0.5, 0.3), L(0.25, 0.5, 0.6, 0)] },
  S: { w: 0.6, strokes: [join(arc(0.3, 0.75, 0.3, 0.25, 20, 270), arc(0.3, 0.25, 0.3, 0.25, 90, -160))] },
  T: { w: 0.6, strokes: [L(0, 1, 0.6, 1), L(0.3, 1, 0.3, 0)] },
  U: { w: 0.6, strokes: [join(L(0, 1, 0, 0.3), arc(0.3, 0.3, 0.3, 0.3, 180, 360), L(0.6, 0.3, 0.6, 1))] },
  V: { w: 0.64, strokes: [L(0, 1, 0.32, 0, 0.64, 1)] },
  W: { w: 0.9, strokes: [L(0, 1, 0.22, 0, 0.45, 0.7, 0.68, 0, 0.9, 1)] },
  X: { w: 0.6, strokes: [L(0, 1, 0.6, 0), L(0, 0, 0.6, 1)] },
  Y: { w: 0.6, strokes: [L(0, 1, 0.3, 0.5, 0.6, 1), L(0.3, 0.5, 0.3, 0)] },
  Z: { w: 0.6, strokes: [L(0, 1, 0.6, 1, 0, 0, 0.6, 0)] },
  '0': { w: 0.6, strokes: [arc(0.3, 0.5, 0.3, 0.5, 90, 450)] },
  '1': { w: 0.3, strokes: [L(0.05, 0.8, 0.25, 1, 0.25, 0)] },
  '2': { w: 0.6, strokes: [join(arc(0.3, 0.72, 0.3, 0.28, 160, -40), L(0, 0, 0.6, 0))] },
  '3': { w: 0.6, strokes: [arc(0.3, 0.75, 0.3, 0.25, 150, -90), arc(0.3, 0.25, 0.3, 0.25, 90, -150)] },
  '4': { w: 0.6, strokes: [L(0.45, 0, 0.45, 1, 0, 0.3, 0.6, 0.3)] },
  '5': { w: 0.6, strokes: [L(0.55, 1, 0.05, 1, 0.128, 0.546), arc(0.3, 0.3, 0.3, 0.3, 125, -140)] },
  '6': { w: 0.6, strokes: [join(arc(0.6, 0.3, 0.6, 0.7, 90, 180), arc(0.3, 0.3, 0.3, 0.3, 180, 540))] },
  '7': { w: 0.6, strokes: [L(0, 1, 0.6, 1, 0.2, 0)] },
  '8': { w: 0.6, strokes: [join(arc(0.3, 0.75, 0.27, 0.25, 270, 630), arc(0.3, 0.25, 0.3, 0.25, 90, -270))] },
  '9': { w: 0.6, strokes: [join(arc(0.3, 0.7, 0.3, 0.3, 0, -360), arc(0, 0.7, 0.6, 0.7, 0, -90))] },
  '!': { w: 0, strokes: [L(0, 1, 0, 0.3), dot(0)] },
  '?': { w: 0.6, strokes: [join(arc(0.3, 0.72, 0.28, 0.28, 160, -90), L(0.3, 0.44, 0.3, 0.25)), dot(0.3)] },
};

export const MAX_CHARS = 12;
export const MAX_WORDS = 2;

/**
 * Clean up a typed message: upper case, only characters the font has, single
 * spaces, at most two words and 12 characters (not counting the space).
 */
export function sanitizeMessage(raw: string): string {
  const words = raw
    .toUpperCase()
    .split(/\s+/)
    .map((w) => [...w].filter((c) => c in GLYPHS).join(''))
    .filter((w) => w.length > 0)
    .slice(0, MAX_WORDS);
  const out: string[] = [];
  let left = MAX_CHARS;
  for (const w of words) {
    if (left <= 0) break;
    out.push(w.slice(0, left));
    left -= Math.min(w.length, left);
  }
  return out.join(' ');
}
