import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEC, PlaneState, emptyInput, groundAttitude, restHeight, stallAlphaAt, stepFlight, type Env } from '../src/plane/flight';
import {
  DEFAULT_LOADOUT,
  PAINTS,
  STYLES,
  WHEELS,
  composeSpec,
  gearFor,
  loadoutStats,
  loadoutToString,
  parseLoadout,
  sanitizeLoadout,
  stallSpeed,
  type Loadout,
} from '../src/plane/loadout';
import { bankAngle } from '../src/plane/steer';

const DT = 1 / 120;
const GROUND = 10;
const RUNWAY = 900;

interface Run {
  takeoffRun: number;
  crashed: string | null;
  touchdownSink: number;
  landingRoll: number;
  stall: number;
  touchdownSpeed: number;
}

/** Flap lever for take-off (until 60 m up) and for the approach and landing. */
interface Flaps {
  takeoff: number;
  landing: number;
}

/** Headless pilot: full-throttle takeoff, climb, straight-in 3° approach, flare, brake. */
function flySortie(l: Loadout, trace?: (phase: string, s: PlaneState, crashed: string | null) => void, flaps: Flaps = { takeoff: 0, landing: 0 }): Run {
  const spec = composeSpec(l);
  const gear = gearFor(l);
  const env: Env = { groundHeight: () => GROUND, surfaceAt: () => 'paved', wind: new THREE.Vector3() };
  const s = new PlaneState();
  s.quat.copy(groundAttitude(0, -1, gear));
  s.pos.set(0, GROUND + restHeight(s.quat, gear), 0);
  const inp = emptyInput();
  const vs = stallSpeed(spec);
  const vsTo = stallSpeed(spec, flaps.takeoff);
  const vsLand = stallSpeed(spec, flaps.landing);
  const vr = vsTo * 1.15;
  const out: Run = { takeoffRun: Infinity, crashed: null, touchdownSink: 0, landingRoll: Infinity, stall: vs, touchdownSpeed: 0 };
  let phase: 'roll' | 'climb' | 'cruise' | 'approach' | 'flare' | 'rollout' = 'roll';
  let touchX = 0;
  let wheelsOffX = 0;
  const levelWings = () => {
    inp.roll = THREE.MathUtils.clamp(bankAngle(s) * 0.9 + s.angVel.z * 0.25, -1, 1);
    inp.yaw = 0;
  };
  const holdVy = (target: number) => {
    const aMax = stallAlphaAt(spec, s.flaps) * 0.8;
    inp.pitch = THREE.MathUtils.clamp((target - s.vel.y) * 0.25 - s.angVel.x * 0.8, -1, 1);
    // stall protection, like the Arcade assist
    if (s.alpha > aMax) inp.pitch = Math.min(inp.pitch, (aMax - s.alpha) * 4);
  };
  const rotate = () => {
    inp.pitch = THREE.MathUtils.clamp((stallAlphaAt(spec, s.flaps) * 0.85 - s.alpha) * 4 - s.angVel.x * 0.8, -1, 1);
  };
  for (let i = 0; i < 120 * 240; i++) {
    const agl = s.pos.y - GROUND;
    const v = s.airspeed;
    inp.flaps = phase === 'roll' || (phase === 'climb' && agl < 60) ? flaps.takeoff : phase === 'cruise' || phase === 'climb' ? 0 : flaps.landing;
    switch (phase) {
      case 'roll':
        inp.throttle = 1;
        if (v > vr) rotate();
        else inp.pitch = !gear.tricycle && v < vr * 0.5 ? -0.3 : 0;
        if (s.onGround) wheelsOffX = -s.pos.z;
        if (!s.onGround && agl > 4) {
          // ground roll: distance until the wheels left the runway for good
          out.takeoffRun = wheelsOffX;
          phase = 'climb';
        }
        break;
      case 'climb':
        inp.throttle = 1;
        levelWings();
        holdVy(v > vs * 1.35 ? 4 : 0.5);
        if (agl > 100) phase = 'cruise';
        break;
      case 'cruise':
        levelWings();
        holdVy((110 - agl) * 0.2);
        inp.throttle = THREE.MathUtils.clamp(0.5 + (vs * 1.35 - v) * 0.08, 0, 1);
        if (Math.abs(v - vs * 1.35) < 2 && i > 120 * 40) phase = 'approach';
        if (i > 120 * 120) phase = 'approach';
        break;
      case 'approach':
        levelWings();
        holdVy(-Math.tan((3 * Math.PI) / 180) * v);
        inp.throttle = THREE.MathUtils.clamp(0.35 + (vsLand * 1.3 - v) * 0.08, 0, 1);
        if (agl < 6) phase = 'flare';
        break;
      case 'flare':
        levelWings();
        holdVy(-0.5);
        inp.throttle = 0;
        if (s.onGround) {
          touchX = -s.pos.z;
          out.touchdownSpeed = s.airspeed;
          phase = 'rollout';
        }
        break;
      case 'rollout':
        inp.throttle = 0;
        if (!s.onGround) {
          // bounced: keep flying the flare until the wheels stay down
          levelWings();
          holdVy(-0.5);
          break;
        }
        inp.roll = 0;
        inp.pitch = gear.tricycle ? -0.2 : 0.3;
        inp.brake = s.groundTime > 0.6;
        if (s.vel.length() < 1) {
          out.landingRoll = -s.pos.z - touchX;
          return out;
        }
        break;
    }
    const ev = stepFlight(s, spec, inp, env, DT, gear);
    trace?.(phase, s, ev.crashed);
    if (ev.touchdown && phase === 'rollout' && out.touchdownSink === 0) out.touchdownSink = ev.touchdown.sink;
    if (ev.touchdown && phase === 'flare') out.touchdownSink = ev.touchdown.sink;
    if (ev.crashed) {
      out.crashed = `${ev.crashed} in ${phase}`;
      return out;
    }
  }
  out.crashed = `timeout in ${phase}`;
  return out;
}

const ALL: Loadout[] = [];
for (const st of STYLES) for (const w of WHEELS) ALL.push({ style: st.id, paint: 'sunflower', wheels: w.id });

describe('loadouts (design §8)', () => {
  it('the default loadout is exactly the original biplane', () => {
    expect(composeSpec(DEFAULT_LOADOUT)).toEqual(DEFAULT_SPEC);
  });

  it('there are 3 styles, 8 paints and 3 wheels (72 combinations)', () => {
    expect(STYLES.length * PAINTS.length * WHEELS.length).toBe(72);
  });

  it('parses, prints and sanitises loadouts', () => {
    const l: Loadout = { style: 'jet', paint: 'scarlet', wheels: 'soft' };
    expect(parseLoadout(loadoutToString(l))).toEqual(l);
    expect(sanitizeLoadout({ style: 'zeppelin', paint: 'plum', wheels: 42 })).toEqual({ ...DEFAULT_LOADOUT, paint: 'plum' });
    // older links with an engine part still work
    expect(parseLoadout('jet.scarlet.prop.soft')).toEqual(l);
    expect(parseLoadout('nonsense')).toBeNull();
  });

  // paint is cosmetic, so the 9 flight-relevant combinations cover all 72
  it.each(ALL.map((l) => [loadoutToString(l), l] as const))('%s takes off and lands on the runway', (_name, l) => {
    const r = flySortie(l);
    expect(r.crashed).toBeNull();
    expect(r.stall).toBeLessThanOrEqual(45);
    expect(r.takeoffRun).toBeLessThanOrEqual(RUNWAY * 0.7);
    expect(r.landingRoll).toBeLessThan(RUNWAY - 150);
  });

  // flaps (plan step 24): take-off flaps shorten the run, full flaps land slower
  it.each(ALL.map((l) => [loadoutToString(l), l] as const))('%s: flaps shorten the take-off and slow the landing', (_name, l) => {
    const clean = flySortie(l);
    const flapped = flySortie(l, undefined, { takeoff: 0.5, landing: 1 });
    expect(flapped.crashed).toBeNull();
    expect(flapped.takeoffRun).toBeLessThan(clean.takeoffRun);
    expect(flapped.touchdownSpeed).toBeLessThan(clean.touchdownSpeed * 0.95);
    expect(flapped.landingRoll).toBeLessThan(RUNWAY - 150);
  });

  it('stat bars rank the styles sensibly', () => {
    const st = (l: Partial<Loadout>) => loadoutStats(composeSpec({ ...DEFAULT_LOADOUT, ...l }));
    const bi = st({});
    const jet = st({ style: 'jet' });
    expect(jet.topSpeed).toBeGreaterThan(bi.topSpeed * 2);
    expect(jet.takeoffRun).toBeGreaterThan(bi.takeoffRun);
    expect(st({ wheels: 'soft' }).landing).toBeGreaterThan(st({ wheels: 'hard' }).landing);
  });
});

export { flySortie };
