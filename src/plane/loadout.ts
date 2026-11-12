import * as THREE from 'three';
import { DEFAULT_SPEC, type Gear, type PlaneSpec } from './flight';

/**
 * Hangar loadout (design §8): plane style, paint and wheels. The engine comes
 * with the style (Biplane = prop, Turboprop = turbo, Jet = jet). Style and
 * wheels compose the flight numbers (ADR "Composable loadout specs"); paint
 * is cosmetic. Every combination must fly
 * (rule "Every combination flies", checked by tests/loadout.test.ts).
 */
export type PlaneStyle = 'biplane' | 'turboprop' | 'jet';
export type PaintId = 'sunflower' | 'scarlet' | 'sky' | 'teal' | 'meadow' | 'plum' | 'snow' | 'charcoal';
export type EngineId = 'prop' | 'turbo' | 'jet';
export type WheelId = 'hard' | 'medium' | 'soft';

export interface Loadout {
  style: PlaneStyle;
  paint: PaintId;
  wheels: WheelId;
}

export const DEFAULT_LOADOUT: Loadout = { style: 'biplane', paint: 'sunflower', wheels: 'medium' };

export interface Livery {
  body: number;
  accent: number;
  wing: number;
  wingUnder: number;
  emblemOuter: number;
  emblemInner: number;
  /** darker stripe for pale paints so they stay readable against the sky */
  stripe: number | null;
}

// ------------------------------------------------------------------ options

interface Option<T extends string> {
  id: T;
  name: string;
  trait: string;
  icon: string;
}

export const STYLES: Option<PlaneStyle>[] = [
  { id: 'biplane', name: 'Biplane', trait: 'Wooden prop. Floaty, nimble, shortest takeoff', icon: '🛩️' },
  { id: 'turboprop', name: 'Turboprop', trait: 'Turbo prop. Balanced speed and handling', icon: '✈️' },
  { id: 'jet', name: 'Jet', trait: 'Jet engine. Very fast, slow to spool, lands hot', icon: '🚀' },
];

export const WHEELS: Option<WheelId>[] = [
  { id: 'hard', name: 'Hard', trait: 'Quick on asphalt, bouncy landings', icon: '⚫' },
  { id: 'medium', name: 'Medium', trait: 'All-rounder', icon: '🛞' },
  { id: 'soft', name: 'Soft', trait: 'Forgiving landings, longer takeoff', icon: '🎈' },
];

interface PaintDef {
  id: PaintId;
  name: string;
  body: number;
  accent: number;
  stripe?: number;
}

export const PAINTS: PaintDef[] = [
  { id: 'sunflower', name: 'Sunflower', body: 0xf2b134, accent: 0x2a9d8f },
  { id: 'scarlet', name: 'Scarlet', body: 0xd94a3d, accent: 0x264653 },
  { id: 'sky', name: 'Sky', body: 0x4aa3df, accent: 0xf2b134, stripe: 0x1f4e79 },
  { id: 'teal', name: 'Teal', body: 0x2a9d8f, accent: 0xe76f51 },
  { id: 'meadow', name: 'Meadow', body: 0x6bbf59, accent: 0x264653 },
  { id: 'plum', name: 'Plum', body: 0x8e5bb5, accent: 0xf7d36e },
  { id: 'snow', name: 'Snow', body: 0xf4f1e8, accent: 0xd94a3d, stripe: 0x3d3f45 },
  { id: 'charcoal', name: 'Charcoal', body: 0x3d3f45, accent: 0xf2b134 },
];

const _c = new THREE.Color();
const _w = new THREE.Color(0xffffff);
function lighten(hex: number, t: number) {
  return _c.setHex(hex).lerp(_w, t).getHex();
}

export function liveryFor(paint: PaintId): Livery {
  const p = PAINTS.find((x) => x.id === paint) ?? PAINTS[0];
  if (p.id === 'sunflower') {
    // exactly the original player livery
    return { body: 0xf2b134, accent: 0x2a9d8f, wing: 0xf7d36e, wingUnder: 0xe9bf55, emblemOuter: 0x2a9d8f, emblemInner: 0xfff3c4, stripe: null };
  }
  return {
    body: p.body,
    accent: p.accent,
    wing: lighten(p.body, 0.2),
    wingUnder: lighten(p.body, 0.08),
    emblemOuter: p.accent,
    emblemInner: 0xfff3c4,
    stripe: p.stripe ?? null,
  };
}

// ------------------------------------------------------------- airframes

type V3 = [number, number, number];

export interface AirframeDef {
  spec: Partial<PlaneSpec>;
  /** the engine that comes with this plane */
  engine: EngineId;
  gear: 'taildragger' | 'tricycle';
  /** main wheel axles (body space); contact point = axle − tyre radius */
  mains: V3[];
  /** tail skid contact (taildragger) or nose wheel axle (tricycle) */
  third: V3;
  /** where the propeller hub sits (jet: where the exhaust flame starts, pointing +Z) */
  engineMount: V3;
  crash: { p: V3; kind: 'wing' | 'nose' | 'top' | 'tail' }[];
}

/** Base masses etc. Inertia, gear spring and damper scale with the final mass. */
export const AIRFRAMES: Record<PlaneStyle, AirframeDef> = {
  biplane: {
    spec: {},
    engine: 'prop',
    gear: 'taildragger',
    mains: [
      [-0.92, -1.0, -0.6],
      [0.92, -1.0, -0.6],
    ],
    third: [0, -0.22, 3.85],
    engineMount: [0, 0.05, -2.9],
    crash: [
      { p: [-4.0, -0.45, -0.55], kind: 'wing' },
      { p: [4.0, -0.45, -0.55], kind: 'wing' },
      { p: [-4.3, 1.5, -1.0], kind: 'wing' },
      { p: [4.3, 1.5, -1.0], kind: 'wing' },
      { p: [0, 0.05, -3.0], kind: 'nose' },
      { p: [0, 1.65, -1.0], kind: 'top' },
      { p: [0, 1.2, 4.1], kind: 'top' },
    ],
  },
  turboprop: {
    spec: {
      mass: 1300,
      wingArea: 16,
      cl0: 0.15,
      clSlope: 5.0,
      stallAlpha: 0.24,
      cd0: 0.024,
      inducedK: 0.06,
      sideArea: 7,
      pitchAcc: 5.2,
      rollAcc: 8,
      yawAcc: 2.2,
      qRef: 1100,
      groundSteer: 1.4,
    },
    engine: 'turbo',
    gear: 'tricycle',
    mains: [
      [-1.35, -1.05, 0.35],
      [1.35, -1.05, 0.35],
    ],
    third: [0, -1.05, -2.5],
    engineMount: [0, 0.05, -3.6],
    crash: [
      { p: [-4.9, -0.4, 0.1], kind: 'wing' },
      { p: [4.9, -0.4, 0.1], kind: 'wing' },
      { p: [0, 0.0, -3.6], kind: 'nose' },
      { p: [0, -0.35, 4.0], kind: 'tail' },
      { p: [0, 1.25, -0.3], kind: 'top' },
      { p: [0, 1.7, 4.3], kind: 'top' },
    ],
  },
  jet: {
    spec: {
      mass: 2500,
      wingArea: 22,
      cl0: 0.1,
      clSlope: 3.8,
      stallAlpha: 0.32,
      cd0: 0.02,
      inducedK: 0.08,
      sideArea: 9,
      pitchAcc: 6.2,
      rollAcc: 12,
      yawAcc: 2.0,
      rollDamp: 4.5,
      qRef: 1700,
      groundSteer: 1.2,
    },
    engine: 'jet',
    gear: 'tricycle',
    mains: [
      [-1.3, -0.9, 0.7],
      [1.3, -0.9, 0.7],
    ],
    third: [0, -0.9, -2.9],
    engineMount: [0, 0.05, 4.75],
    crash: [
      { p: [-4.4, -0.2, 2.0], kind: 'wing' },
      { p: [4.4, -0.2, 2.0], kind: 'wing' },
      { p: [0, 0.0, -5.6], kind: 'nose' },
      { p: [0, -0.35, 4.6], kind: 'tail' },
      { p: [0, 1.2, -1.8], kind: 'top' },
      { p: [0, 2.2, 4.4], kind: 'top' },
    ],
  },
};

// ---------------------------------------------------------------- engines

export interface EngineDef {
  /** static thrust / weight of the finished plane */
  thrustToWeight: number;
  /** thrust falls linearly to zero at this forward speed (m/s) */
  propVmax: number;
  /** first-order RPM response rate (1/s) */
  spoolRate: number;
  massAdd: number;
  /** propeller radius, 0 for none */
  propRadius: number;
}

export const ENGINE_DEFS: Record<EngineId, EngineDef> = {
  prop: { thrustToWeight: DEFAULT_SPEC.maxThrust / (DEFAULT_SPEC.mass * 9.81), propVmax: 95, spoolRate: 1.6, massAdd: 0, propRadius: 1.3 },
  turbo: { thrustToWeight: 0.5, propVmax: 140, spoolRate: 0.9, massAdd: 120, propRadius: 1.15 },
  jet: { thrustToWeight: 0.55, propVmax: 200, spoolRate: 0.45, massAdd: 250, propRadius: 0 },
};

// ----------------------------------------------------------------- wheels

export interface WheelDef {
  radius: number;
  width: number;
  gearKMul: number;
  gearCMul: number;
  rollFriction: number;
  brakeFriction: number;
  crashSpeed: number;
  cd0Add: number;
  gripPaved: number;
  gripGrass: number;
}

export const WHEEL_DEFS: Record<WheelId, WheelDef> = {
  hard: { radius: 0.3, width: 0.14, gearKMul: 1.4, gearCMul: 0.9, rollFriction: 0.02, brakeFriction: 0.55, crashSpeed: 5, cd0Add: 0, gripPaved: 1.0, gripGrass: 0.75 },
  medium: { radius: 0.36, width: 0.17, gearKMul: 1, gearCMul: 1, rollFriction: 0.03, brakeFriction: 0.45, crashSpeed: 6, cd0Add: 0, gripPaved: 1.0, gripGrass: 1.0 },
  soft: { radius: 0.48, width: 0.3, gearKMul: 0.65, gearCMul: 1.35, rollFriction: 0.045, brakeFriction: 0.38, crashSpeed: 8, cd0Add: 0.002, gripPaved: 0.85, gripGrass: 1.0 },
};

// --------------------------------------------------------------- compose

/** Loadout → flight numbers. Pure and deterministic. */
export function composeSpec(l: Loadout): PlaneSpec {
  const af = AIRFRAMES[l.style];
  const en = ENGINE_DEFS[af.engine];
  const wh = WHEEL_DEFS[l.wheels];
  const s: PlaneSpec = { ...DEFAULT_SPEC, ...af.spec };
  const baseMass = s.mass;
  s.mass = baseMass + en.massAdd;
  const k = s.mass / DEFAULT_SPEC.mass;
  s.inertiaPitch = DEFAULT_SPEC.inertiaPitch * k;
  s.inertiaYaw = DEFAULT_SPEC.inertiaYaw * k;
  s.inertiaRoll = DEFAULT_SPEC.inertiaRoll * k;
  s.maxThrust = en.thrustToWeight * s.mass * 9.81;
  s.propVmax = en.propVmax;
  s.spoolRate = en.spoolRate;
  s.gearK = DEFAULT_SPEC.gearK * k * wh.gearKMul;
  s.gearC = DEFAULT_SPEC.gearC * k * wh.gearCMul;
  s.rollFriction = wh.rollFriction;
  s.brakeFriction = wh.brakeFriction;
  s.crashSpeed = wh.crashSpeed;
  s.cd0 += wh.cd0Add;
  s.gripPaved = wh.gripPaved;
  s.gripGrass = wh.gripGrass;
  return s;
}

/** The engine that comes with a plane style. */
export function engineOf(style: PlaneStyle): EngineId {
  return AIRFRAMES[style].engine;
}

const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** Contact and crash geometry for a loadout. */
export function gearFor(l: Loadout): Gear {
  const af = AIRFRAMES[l.style];
  const r = WHEEL_DEFS[l.wheels].radius;
  const wheels = af.mains.map((m) => v3(m).setY(m[1] - r));
  const third = af.gear === 'tricycle' ? v3(af.third).setY(af.third[1] - r) : v3(af.third);
  const crash = af.crash.map((c) => ({ p: v3(c.p), kind: c.kind }) as Gear['crash'][number]);
  const pr = ENGINE_DEFS[af.engine].propRadius;
  if (pr > 0) {
    const m = af.engineMount;
    crash.push({ p: new THREE.Vector3(m[0], m[1] - pr + 0.05, m[2] - 0.05), kind: 'prop' });
  }
  return { wheels, third, tricycle: af.gear === 'tricycle', crash };
}

/** Lowest speed the wing can hold the plane up (m/s, clean, sea level). */
export function stallSpeed(s: PlaneSpec): number {
  const clMax = s.cl0 + s.clSlope * s.stallAlpha;
  return Math.sqrt((2 * s.mass * 9.81) / (s.rho * s.wingArea * clMax));
}

export interface LoadoutStats {
  topSpeed: number; // m/s
  climb: number; // m/s
  takeoffRun: number; // m
  stall: number; // m/s
  handling: number; // 0..1
  landing: number; // 0..1
}

const thrustAt = (s: PlaneSpec, v: number) => s.maxThrust * Math.max(0, 1 - v / s.propVmax);

/** Quick analytic numbers for the hangar stat bars. */
export function loadoutStats(s: PlaneSpec): LoadoutStats {
  const stall = stallSpeed(s);
  const W = s.mass * 9.81;
  let top = 0;
  let climb = 0;
  for (let v = stall; v < 260; v += 0.5) {
    const q = 0.5 * s.rho * v * v;
    const cl = W / (q * s.wingArea);
    const D = q * s.wingArea * (s.cd0 + s.inducedK * cl * cl);
    const excess = thrustAt(s, v) - D;
    if (excess > 0) top = v;
    climb = Math.max(climb, (excess * v) / W);
  }
  // 1D ground roll on grass to 1.15 × stall speed
  let v = 0;
  let x = 0;
  const vr = stall * 1.25;
  const mu = s.rollFriction / s.gripGrass;
  for (let i = 0; i < 6000 && v < vr; i++) {
    const q = 0.5 * s.rho * v * v;
    const L = q * s.wingArea * s.cl0;
    const D = q * s.wingArea * s.cd0;
    const a = (thrustAt(s, v) - D - mu * Math.max(0, W - L)) / s.mass;
    v += a * 0.02;
    x += v * 0.02;
  }
  const handling = THREE.MathUtils.clamp((s.rollAcc / 12) * 0.6 + (1 - s.mass / 3200) * 0.4, 0, 1);
  const landing = THREE.MathUtils.clamp((s.crashSpeed / 8) * 0.6 + (1 - (stall - 15) / 32) * 0.4, 0, 1);
  return { topSpeed: top, climb, takeoffRun: x, stall, handling, landing };
}

// ---------------------------------------------------------- save / share

const KEY = 'baron.loadout.v1';
const ids = {
  style: STYLES.map((o) => o.id) as string[],
  paint: PAINTS.map((o) => o.id) as string[],
  wheels: WHEELS.map((o) => o.id) as string[],
};

/** Field-by-field validation; unknown values fall back to the default. */
export function sanitizeLoadout(x: Partial<Record<keyof Loadout, unknown>> | null | undefined): Loadout {
  const out = { ...DEFAULT_LOADOUT };
  if (!x) return out;
  for (const k of Object.keys(ids) as (keyof Loadout)[]) {
    const v = x[k];
    if (typeof v === 'string' && ids[k].includes(v)) (out as Record<string, string>)[k] = v;
  }
  return out;
}

/** "style.paint.wheels", as used by ?plane= */
export function loadoutToString(l: Loadout): string {
  return `${l.style}.${l.paint}.${l.wheels}`;
}

export function parseLoadout(str: string): Loadout | null {
  const parts = str.split('.');
  if (parts.length < 3) return null;
  // older links had an engine part: style.paint.engine.wheels
  const [style, paint] = parts;
  return sanitizeLoadout({ style, paint, wheels: parts[parts.length - 1] });
}

export function loadLoadout(): Loadout {
  try {
    const q = new URLSearchParams(location.search).get('plane');
    const fromUrl = q ? parseLoadout(q) : null;
    if (fromUrl) return fromUrl;
  } catch {
    /* no location (tests) */
  }
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitizeLoadout(JSON.parse(raw));
  } catch {
    /* storage unavailable or bad JSON */
  }
  return { ...DEFAULT_LOADOUT };
}

export function saveLoadout(l: Loadout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* storage unavailable */
  }
}

export function describeLoadout(l: Loadout): string {
  const n = <T extends string>(opts: { id: T; name: string }[], id: T) => opts.find((o) => o.id === id)?.name ?? id;
  return `${n(STYLES, l.style)} · ${n(PAINTS, l.paint)} · ${n(WHEELS, l.wheels)} wheels`;
}
