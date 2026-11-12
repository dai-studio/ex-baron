import type { Surface } from '../plane/flight';
import { Simplex2 } from './noise';
import { hash32, mulberry32, type Rng } from './rng';

/**
 * Terrain heightfield, biomes & airfield placement (design §4).
 * Pure, deterministic and DOM/three-free so it runs identically on the
 * main thread (collision, AI) and in the chunk Web Workers (meshes).
 */
export const CHUNK_SIZE = 512;
/** Grid spacing of the finest terrain LOD; collision uses the same grid. */
export const GROUND_CELL = 8;
export const SEA_LEVEL = 0;

export interface Airfield {
  id: number;
  x: number;
  z: number;
  heading: number;
  dirX: number;
  dirZ: number;
  /** whole strip incl. grass overruns (m) */
  length: number;
  /** asphalt + grass shoulders (m) */
  width: number;
  /** asphalt runway length and width (design §8.3) */
  paved: number;
  pavedWidth: number;
  height: number;
  home: boolean;
}

/** Runway layout shared by every airfield (design §8.3). */
export const RUNWAY = { paved: 900, pavedWidth: 30, overrun: 60, shoulder: 15 };

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export function smoothstep(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

type RGB = [number, number, number];
/** sRGB hex → linear RGB (vertex colours are linear in three.js). */
function lin(hex: number): RGB {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

const PAL = {
  deep: lin(0x1d5f93),
  shallow: lin(0x3cc0cf),
  foam: lin(0xf4fbff),
  sand: lin(0xf2d896),
  meadow: lin(0x86c24f),
  meadow2: lin(0x79b84a),
  airfield: lin(0x8cc756),
  forest: lin(0x3e8f3c),
  forest2: lin(0x4d9e3a),
  rock: lin(0xa89a8c),
  rockDark: lin(0x8c7d72),
  snow: lin(0xfbfdff),
  farm: [lin(0xc6d160), lin(0x93bf4c), lin(0xdcbd62), lin(0x77b148), lin(0xadc96c), lin(0xcfa660)],
};

export const PROP_PINE = 0;
export const PROP_ROUND = 1;
export const PROP_HOUSE = 2;
export const PROP_BARN = 3;
export const PROP_WINDMILL = 4;

const FLAT_A = 40; // flattened area extends this far past the strip ends
const FLAT_B = 110; // half-width of the flattened area (room for hangars and apron)
const FLAT_F = 260; // falloff distance

export class TerrainGen {
  readonly airfields: Airfield[];
  private nCont: Simplex2;
  private nHill: Simplex2;
  private nMask: Simplex2;
  private nRidge: Simplex2;
  private nWarp: Simplex2;
  private nForest: Simplex2;
  private nFarm: Simplex2;
  private nVar: Simplex2;

  constructor(readonly seed: number) {
    this.nCont = new Simplex2(hash32(seed, 1));
    this.nHill = new Simplex2(hash32(seed, 2));
    this.nMask = new Simplex2(hash32(seed, 3));
    this.nRidge = new Simplex2(hash32(seed, 4));
    this.nWarp = new Simplex2(hash32(seed, 5));
    this.nForest = new Simplex2(hash32(seed, 7));
    this.nFarm = new Simplex2(hash32(seed, 8));
    this.nVar = new Simplex2(hash32(seed, 9));
    this.airfields = [];
    this.placeAirfields();
  }

  private fbm(n: Simplex2, x: number, z: number, oct: number): number {
    let a = 1;
    let f = 1;
    let s = 0;
    let t = 0;
    for (let i = 0; i < oct; i++) {
      s += a * n.noise(x * f, z * f);
      t += a;
      a *= 0.5;
      f *= 2.03;
    }
    return s / t;
  }

  private ridged(n: Simplex2, x: number, z: number, oct: number): number {
    let a = 1;
    let f = 1;
    let s = 0;
    let t = 0;
    let prev = 1;
    for (let i = 0; i < oct; i++) {
      let v = 1 - Math.abs(n.noise(x * f, z * f));
      v *= v;
      s += v * a * prev;
      t += a;
      prev = v;
      a *= 0.5;
      f *= 2.1;
    }
    return s / t;
  }

  /** Height before airfield flattening (metres above sea level). */
  rawHeight(x: number, z: number): number {
    const wx = x + 350 * this.nWarp.noise(x / 2800, z / 2800);
    const wz = z + 350 * this.nWarp.noise(x / 2800 + 31.7, z / 2800 - 17.3);
    const c = this.fbm(this.nCont, wx / 11000, wz / 11000, 4);
    let h = 55 + c * 330;
    h += this.fbm(this.nHill, wx / 1500, wz / 1500, 4) * 48;
    const m = smoothstep(0.05, 0.55, this.nMask.noise(wx / 8000, wz / 8000)) * smoothstep(-0.05, 0.25, c);
    if (m > 0) {
      const r = this.ridged(this.nRidge, wx / 2400, wz / 2400, 4);
      h += m * Math.pow(r, 1.5) * 640;
    }
    // gentle terraces for the cartoon look (not on beaches)
    if (h > 4) {
      const step = 16;
      const k = (h - 4) / step;
      const f = Math.floor(k);
      const fr = k - f;
      h = 4 + (f + fr * 0.45 + smoothstep(0.3, 0.7, fr) * 0.55) * step;
    }
    return h;
  }

  /** 0..1: how strongly an airfield flattens this point. */
  private fieldT(af: Airfield, x: number, z: number): number {
    const dx = x - af.x;
    const dz = z - af.z;
    const reach = af.length / 2 + FLAT_A + FLAT_F + FLAT_B;
    if (dx * dx + dz * dz > reach * reach) return 0;
    const u = dx * af.dirX + dz * af.dirZ;
    const v = -dx * af.dirZ + dz * af.dirX;
    const du = Math.max(Math.abs(u) - (af.length / 2 + FLAT_A), 0);
    const dv = Math.max(Math.abs(v) - FLAT_B, 0);
    return 1 - smoothstep(0, FLAT_F, Math.sqrt(du * du + dv * dv));
  }

  fieldMask(x: number, z: number): number {
    let t = 0;
    for (const af of this.airfields) t = Math.max(t, this.fieldT(af, x, z));
    return t;
  }

  /** Final terrain height used by meshes, collision and AI. */
  height(x: number, z: number): number {
    let h = this.rawHeight(x, z);
    for (const af of this.airfields) {
      const t = this.fieldT(af, x, z);
      if (t > 0) h += (af.height - h) * t;
    }
    return h;
  }

  slopeAt(x: number, z: number): number {
    const e = 4;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    const ny = 2 * e / Math.sqrt(hx * hx + hz * hz + 4 * e * e);
    return 1 - ny;
  }

  forestDensity(x: number, z: number, h: number, slope: number, field: number): number {
    if (h < 3) return 0;
    const f = this.fbm(this.nForest, x / 1800, z / 1800, 3);
    return (
      smoothstep(0.04, 0.28, f) *
      (1 - smoothstep(0.35, 0.5, slope)) *
      (1 - smoothstep(320, 430, h)) *
      (1 - smoothstep(0.0, 0.3, field))
    );
  }

  farmMask(x: number, z: number, h: number, slope: number): number {
    if (h < 5 || h > 170 || slope > 0.22) return 0;
    return smoothstep(-0.05, 0.12, this.nFarm.noise(x / 5000, z / 5000));
  }

  /** Voronoi patchwork cell id for farmland colours. */
  private farmCell(x: number, z: number): number {
    const cs = 230;
    const gx = Math.floor(x / cs);
    const gz = Math.floor(z / cs);
    let best = 1e18;
    let id = 0;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const cx = gx + i;
        const cz = gz + j;
        const hsh = hash32(this.seed, cx, cz, 31);
        const px = (cx + (hsh & 0xffff) / 65536) * cs;
        const pz = (cz + ((hsh >>> 16) & 0xffff) / 65536) * cs;
        const d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d < best) {
          best = d;
          id = hsh;
        }
      }
    return id;
  }

  isPine(x: number, z: number, h: number): boolean {
    return h > 190 || this.nVar.noise(x / 700, z / 700) > 0.25;
  }

  /** Vertex colour for a terrain point (linear RGB) written to out[o..o+2]. */
  colorAt(x: number, z: number, h: number, ny: number, out: Float32Array, o: number) {
    let c: RGB;
    const slope = 1 - ny;
    if (h < -0.6) {
      const t = smoothstep(-0.6, -9, h);
      out[o] = PAL.shallow[0] + (PAL.deep[0] - PAL.shallow[0]) * t;
      out[o + 1] = PAL.shallow[1] + (PAL.deep[1] - PAL.shallow[1]) * t;
      out[o + 2] = PAL.shallow[2] + (PAL.deep[2] - PAL.shallow[2]) * t;
      return;
    } else if (h < 0.6) c = PAL.foam;
    else if (h < 5 && slope < 0.2) c = PAL.sand;
    else if (slope > 0.42) c = slope > 0.58 ? PAL.rockDark : PAL.rock;
    else if (h > 440 + 70 * this.nVar.noise(x / 400, z / 400)) c = slope < 0.3 ? PAL.snow : PAL.rock;
    else {
      const field = this.fieldMask(x, z);
      if (field > 0.45) c = PAL.airfield;
      else {
        const fd = this.forestDensity(x, z, h, slope, field);
        if (fd > 0.45) c = this.nVar.noise(x / 300, z / 300) > 0 ? PAL.forest : PAL.forest2;
        else if (this.farmMask(x, z, h, slope) > 0.5 && field < 0.05) c = PAL.farm[this.farmCell(x, z) % PAL.farm.length];
        else c = this.nVar.noise(x / 900, z / 900) > 0.1 ? PAL.meadow2 : PAL.meadow;
      }
    }
    const v = 1 + 0.06 * this.nVar.noise(x / 160 + 50, z / 160);
    out[o] = c[0] * v;
    out[o + 1] = c[1] * v;
    out[o + 2] = c[2] * v;
  }

  // ---------------------------------------------------------------- airfields

  private scoreSite(x: number, z: number, heading: number): { score: number; mean: number } {
    const dx = Math.cos(heading);
    const dz = Math.sin(heading);
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    let n = 0;
    for (const u of [-510, -340, -170, 0, 170, 340, 510])
      for (const v of [-90, 0, 90]) {
        const px = x + dx * u - dz * v;
        const pz = z + dz * u + dx * v;
        const h = this.rawHeight(px, pz);
        if (h < mn) mn = h;
        if (h > mx) mx = h;
        sum += h;
        n++;
      }
    const mean = sum / n;
    let score = mx - mn;
    if (mn < 10) score += 1000 + (10 - mn) * 5;
    if (mean > 200) score += (mean - 200) * 0.6;
    return { score, mean };
  }

  private searchField(cx: number, cz: number, radius: number, step: number, r: Rng, id: number, home: boolean): { af: Airfield; score: number } {
    let best = { score: Infinity, x: cx, z: cz, heading: 0, mean: 20 };
    for (let gz = -radius; gz <= radius; gz += step)
      for (let gx = -radius; gx <= radius; gx += step) {
        if (gx * gx + gz * gz > radius * radius) continue;
        const h0 = r() * Math.PI;
        for (const heading of [h0, h0 + Math.PI / 2]) {
          const s = this.scoreSite(cx + gx, cz + gz, heading);
          const total = s.score + Math.hypot(gx, gz) * 0.004;
          if (total < best.score) best = { score: total, x: cx + gx, z: cz + gz, heading, mean: s.mean };
        }
      }
    const af: Airfield = {
      id,
      x: best.x,
      z: best.z,
      heading: best.heading,
      dirX: Math.cos(best.heading),
      dirZ: Math.sin(best.heading),
      length: RUNWAY.paved + 2 * RUNWAY.overrun,
      width: RUNWAY.pavedWidth + 2 * RUNWAY.shoulder,
      paved: RUNWAY.paved,
      pavedWidth: RUNWAY.pavedWidth,
      height: Math.max(best.mean, 9),
      home,
    };
    return { af, score: best.score };
  }

  private placeAirfields() {
    const r = mulberry32(hash32(this.seed, 99));
    let home = this.searchField(0, 0, 1800, 150, r, 0, true);
    if (home.score >= 1000) home = this.searchField(0, 0, 7000, 450, r, 0, true);
    this.airfields.push(home.af);
    const base = r() * Math.PI * 2;
    for (let k = 0; k < 4; k++) {
      const a = base + (k * Math.PI) / 2 + (r() - 0.5) * 0.8;
      const d = 4500 + r() * 2500;
      const f = this.searchField(home.af.x + Math.cos(a) * d, home.af.z + Math.sin(a) * d, 1500, 250, r, k + 1, false);
      this.airfields.push(f.af);
    }
  }

  /** Is (x,z) on a runway strip? Returns the airfield or null. */
  runwayAt(x: number, z: number, margin = 0): Airfield | null {
    for (const af of this.airfields) {
      const dx = x - af.x;
      const dz = z - af.z;
      const u = dx * af.dirX + dz * af.dirZ;
      const v = -dx * af.dirZ + dz * af.dirX;
      if (Math.abs(u) <= af.length / 2 + margin && Math.abs(v) <= af.width / 2 + margin) return af;
    }
    return null;
  }

  /** What a wheel rolls on at (x,z): asphalt, mowed grass, rough ground or water. */
  surfaceAt(x: number, z: number): Surface {
    for (const af of this.airfields) {
      const dx = x - af.x;
      const dz = z - af.z;
      const u = Math.abs(dx * af.dirX + dz * af.dirZ);
      const v = Math.abs(-dx * af.dirZ + dz * af.dirX);
      if (u > af.length / 2 + FLAT_A + 200) continue;
      if (u <= af.paved / 2 && v <= af.pavedWidth / 2) return 'paved';
      if (u <= af.length / 2 && v <= af.width / 2) return 'grass';
    }
    if (this.fieldMask(x, z) > 0.45) return 'grass';
    return this.height(x, z) < 0 ? 'water' : 'rough';
  }

  nearestAirfield(x: number, z: number): { af: Airfield; dist: number } {
    let best = this.airfields[0];
    let bd = Infinity;
    for (const af of this.airfields) {
      const d = Math.hypot(af.x - x, af.z - z);
      if (d < bd) {
        bd = d;
        best = af;
      }
    }
    return { af: best, dist: bd };
  }
}
