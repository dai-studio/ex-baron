import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PlaneState, TRIM_ALPHA, TRIM_ALPHA_DOWN, emptyInput, stallAlphaAt, stepFlight, trimForAlpha, trimmedAlpha } from '../src/plane/flight';
import { STYLES, composeSpec, stallSpeed } from '../src/plane/loadout';

const DT = 1 / 120;
const env = { groundHeight: () => 0, wind: new THREE.Vector3() };

/** Fly hands-off at a fixed throttle and trim for a minute; returns the average airspeed after the first 20 s. */
function handsOff(style: string, trim: number, throttle = 0.6) {
  const spec = composeSpec({ style: style as never, paint: 'sunflower', wheels: 'medium' });
  const s = new PlaneState();
  s.pos.set(0, 3000, 0);
  s.vel.set(0, 0, -stallSpeed(spec) * 1.6);
  s.rpm = throttle;
  const inp = emptyInput();
  inp.throttle = throttle;
  inp.pitchTrim = trim;
  let sum = 0;
  let n = 0;
  let stalled = false;
  let crashed = false;
  for (let i = 0; i < 120 * 60; i++) {
    crashed ||= !!stepFlight(s, spec, inp, env, DT).crashed;
    if (i > 120 * 20) {
      sum += s.airspeed;
      n++;
      stalled ||= s.stalled;
    }
  }
  return { speed: sum / n, stalled, crashed, spec };
}

describe('elevator trim', () => {
  for (const st of STYLES) {
    it(`more nose-up trim flies slower hands-off, never stalls (${st.id})`, () => {
      const down = handsOff(st.id, -1);
      const mid = handsOff(st.id, 0);
      const up = handsOff(st.id, 1);
      expect(up.speed).toBeLessThan(mid.speed - 2);
      expect(mid.speed).toBeLessThan(down.speed - 2);
      expect(up.stalled || mid.stalled || down.stalled).toBe(false);
      expect(up.crashed || mid.crashed || down.crashed).toBe(false);
      expect(up.speed).toBeGreaterThan(stallSpeed(up.spec) * 1.05);
    });
  }

  it('trim at 0 leaves the built-in trimmed angle unchanged; trim alone stays clear of the stall', () => {
    const spec = composeSpec({ style: 'biplane', paint: 'sunflower', wheels: 'medium' });
    expect(trimmedAlpha(spec, 0, 0)).toBeCloseTo(spec.alphaTrim, 10);
    expect(trimmedAlpha(spec, 1, 0)).toBeCloseTo(spec.alphaTrim - spec.flapTrim, 10);
    expect(trimmedAlpha(spec, 0, 0.5)).toBeCloseTo(spec.alphaTrim + TRIM_ALPHA * 0.5, 10);
    expect(trimmedAlpha(spec, 0, -1)).toBeCloseTo(spec.alphaTrim - TRIM_ALPHA_DOWN, 10);
    for (const fl of [0, 0.5, 1]) expect(trimmedAlpha(spec, fl, 1)).toBeLessThanOrEqual(stallAlphaAt(spec, fl) * 0.8 + 1e-9);
  });

  it('T: trimming for the current angle of attack, then letting go, holds the speed', () => {
    for (const st of STYLES) {
      const spec = composeSpec({ style: st.id, paint: 'sunflower', wheels: 'medium' });
      // round trip: the trim that makes alpha hands-off gives back that alpha
      for (const t of [-1, -0.4, 0, 0.3, 1]) expect(trimForAlpha(spec, 0, trimmedAlpha(spec, 0, t))).toBeCloseTo(t, 10);
      expect(trimForAlpha(spec, 0, 1)).toBe(1);
      expect(trimForAlpha(spec, 0, -1)).toBe(-1);
      // fly with a little back stick until steady, press T, let go: the speed stays close
      const s = new PlaneState();
      s.pos.set(0, 3000, 0);
      s.vel.set(0, 0, -stallSpeed(spec) * 1.6);
      s.rpm = 0.7;
      const inp = emptyInput();
      inp.throttle = 0.7;
      inp.pitch = 0.012;
      let held = 0;
      for (let i = 0; i < 120 * 40; i++) {
        stepFlight(s, spec, inp, env, DT);
        if (i >= 120 * 30) held += s.airspeed / (120 * 10);
      }
      inp.pitchTrim = trimForAlpha(spec, s.flaps, s.alpha);
      inp.pitch = 0;
      let after = 0;
      for (let i = 0; i < 120 * 40; i++) {
        stepFlight(s, spec, inp, env, DT);
        if (i >= 120 * 30) after += s.airspeed / (120 * 10);
      }
      expect(Math.abs(after - held) / held).toBeLessThan(0.15);
    }
  });
});
