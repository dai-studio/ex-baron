import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEC, PlaneState, emptyInput, groundAttitude, liftCoefficient, restHeight, stallAlphaAt, stepFlight } from '../src/plane/flight';
import { stallSpeed } from '../src/plane/loadout';

const DT = 1 / 120;
const flat = (h: number, wind = new THREE.Vector3()) => ({ groundHeight: () => h, wind });

describe('flight model', () => {
  it('takes off from a grass strip within 300 m at full throttle', () => {
    const env = flat(10);
    const s = new PlaneState();
    s.quat.copy(groundAttitude(0, -1));
    s.pos.set(0, 10 + restHeight(s.quat), 0);
    const inp = emptyInput();
    inp.throttle = 1;
    let liftoff = -1;
    for (let i = 0; i < 120 * 30 && liftoff < 0; i++) {
      const v = s.vel.length();
      inp.pitch = v < 12 ? -0.3 : v > 23 ? 0.3 : 0;
      const ev = stepFlight(s, DEFAULT_SPEC, inp, env, DT);
      expect(ev.crashed).toBeNull();
      if (!s.onGround && s.pos.y - 10 > 3) liftoff = -s.pos.z;
    }
    expect(liftoff).toBeGreaterThan(50);
    expect(liftoff).toBeLessThan(300);
  });

  it('a crosswind ground roll with forward stick does not ground-loop', () => {
    const env = flat(10, new THREE.Vector3(3, 0, 1.5));
    const s = new PlaneState();
    s.quat.copy(groundAttitude(0.6, -0.8));
    s.pos.set(0, 10 + restHeight(s.quat), 0);
    const inp = emptyInput();
    inp.throttle = 1;
    for (let i = 0; i < 120 * 12; i++) {
      const kmh = s.vel.length() * 3.6;
      inp.pitch = kmh > 40 && kmh < 75 ? -1 : 0;
      const ev = stepFlight(s, DEFAULT_SPEC, inp, env, DT);
      expect(ev.crashed).toBeNull();
    }
  });

  it('flies roughly level hands-off at cruise throttle', () => {
    const env = flat(0);
    const s = new PlaneState();
    s.pos.set(0, 800, 0);
    s.vel.set(0, 0, -42);
    s.rpm = 0.65;
    const inp = emptyInput();
    inp.throttle = 0.65;
    for (let i = 0; i < 120 * 30; i++) stepFlight(s, DEFAULT_SPEC, inp, env, DT);
    expect(Math.abs(s.pos.y - 800)).toBeLessThan(80);
    expect(s.airspeed).toBeGreaterThan(30);
    expect(s.airspeed).toBeLessThan(55);
  });

  it('top speed is biplane-like (150-230 km/h level)', () => {
    const env = flat(0);
    const s = new PlaneState();
    s.pos.set(0, 1000, 0);
    s.vel.set(0, 0, -40);
    s.rpm = 1;
    const inp = emptyInput();
    inp.throttle = 1;
    for (let i = 0; i < 120 * 60; i++) {
      // simple altitude hold
      inp.pitch = THREE.MathUtils.clamp((1000 - s.pos.y) * 0.02 - s.vel.y * 0.1, -1, 1);
      stepFlight(s, DEFAULT_SPEC, inp, env, DT);
    }
    const kmh = s.airspeed * 3.6;
    expect(kmh).toBeGreaterThan(150);
    expect(kmh).toBeLessThan(230);
  });

  it('recovers from a power-off stall', () => {
    const env = flat(0);
    const s = new PlaneState();
    s.pos.set(0, 1500, 0);
    s.vel.set(0, 0, -40);
    const inp = emptyInput();
    inp.pitch = 0.8;
    let stalled = false;
    for (let i = 0; i < 120 * 8; i++) {
      stepFlight(s, DEFAULT_SPEC, inp, env, DT);
      if (s.stalled) stalled = true;
    }
    expect(stalled).toBe(true);
    inp.pitch = 0;
    inp.throttle = 1;
    for (let i = 0; i < 120 * 25; i++) stepFlight(s, DEFAULT_SPEC, inp, env, DT);
    expect(s.stalled).toBe(false);
    expect(s.pos.y).toBeGreaterThan(500);
  });

  it('a gentle touchdown is reported with a small sink rate and no crash', () => {
    const env = flat(0);
    const s = new PlaneState();
    // approach: 30 m above the ground, slow, nose slightly up
    s.quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.05);
    s.pos.set(0, 30, 0);
    s.vel.set(0, -1.5, -30);
    s.rpm = 0.3;
    const inp = emptyInput();
    inp.throttle = 0.3;
    let touch: { sink: number } | null = null;
    for (let i = 0; i < 120 * 40 && !touch; i++) {
      const agl = s.pos.y - 1.4;
      // descend at ~2 m/s, flare below 6 m
      const targetVy = agl > 6 ? -2 : -0.6;
      inp.pitch = THREE.MathUtils.clamp((targetVy - s.vel.y) * 0.5 - s.angVel.x * 0.3, -1, 1);
      if (agl < 6) inp.throttle = 0;
      const ev = stepFlight(s, DEFAULT_SPEC, inp, env, DT);
      expect(ev.crashed).toBeNull();
      if (ev.touchdown) touch = ev.touchdown;
    }
    expect(touch).not.toBeNull();
    expect(touch!.sink).toBeLessThan(2.5);
  });

  describe('flaps (plan step 24)', () => {
    it('add lift, lower the stall speed by ~15% at full flap', () => {
      const a = 0.1;
      expect(liftCoefficient(DEFAULT_SPEC, a, 1)).toBeCloseTo(liftCoefficient(DEFAULT_SPEC, a) + DEFAULT_SPEC.flapCl, 5);
      expect(stallAlphaAt(DEFAULT_SPEC, 1)).toBeLessThan(DEFAULT_SPEC.stallAlpha);
      const k = stallSpeed(DEFAULT_SPEC, 1) / stallSpeed(DEFAULT_SPEC);
      expect(k).toBeGreaterThan(0.8);
      expect(k).toBeLessThan(0.9);
      expect(stallSpeed(DEFAULT_SPEC, 0.5)).toBeLessThan(stallSpeed(DEFAULT_SPEC));
    });

    const fly = (speed: number, lever: number, seconds: number) => {
      const env = flat(0);
      const s = new PlaneState();
      s.pos.set(0, 500, 0);
      s.vel.set(0, 0, -speed);
      const inp = emptyInput();
      inp.flaps = lever;
      inp.throttle = 0.6;
      let blown = false;
      for (let i = 0; i < 120 * seconds; i++) {
        // hold the speed: this test is about the flap mechanism, not the flight path
        s.vel.set(0, 0, -speed);
        s.angVel.set(0, 0, 0);
        s.quat.identity();
        stepFlight(s, DEFAULT_SPEC, inp, env, DT);
        blown = blown || s.flapsBlown;
      }
      return { flaps: s.flaps, blown };
    };

    it('run out at flapRate and reach the lever below the flap speed', () => {
      expect(fly(25, 1, 0.5).flaps).toBeCloseTo(0.3, 1);
      const r = fly(25, 1, 3);
      expect(r.flaps).toBe(1);
      expect(r.blown).toBe(false);
      expect(fly(25, 0.5, 3).flaps).toBe(0.5);
    });

    it('are blown back when flying too fast for them', () => {
      const v = DEFAULT_SPEC.flapSpeed;
      const fast = fly(v * 1.4, 1, 3);
      expect(fast.flaps).toBe(0);
      expect(fast.blown).toBe(true);
      const part = fly(v * 1.15, 1, 3);
      expect(part.flaps).toBeGreaterThan(0.3);
      expect(part.flaps).toBeLessThan(0.7);
    });

    it('add drag: a full-flap idle glide is steeper than a clean one', () => {
      const glide = (lever: number) => {
        const env = flat(0);
        const s = new PlaneState();
        s.pos.set(0, 1500, 0);
        s.vel.set(0, -2, -28);
        s.flaps = lever;
        const inp = emptyInput();
        inp.flaps = lever;
        // hold ~1.35× the stall speed for this flap setting with the elevator; average the
        // glide angle over the second half (the slow phugoid makes any one instant noisy)
        const target = stallSpeed(DEFAULT_SPEC, lever) * 1.35;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < 120 * 60; i++) {
          inp.pitch = Math.max(-1, Math.min(1, (target - s.airspeed) * -0.15 - s.angVel.x * 0.8));
          stepFlight(s, DEFAULT_SPEC, inp, env, DT);
          if (i > 120 * 30) {
            sum += Math.atan2(-s.vel.y, Math.hypot(s.vel.x, s.vel.z));
            n++;
          }
        }
        return sum / n;
      };
      expect(glide(1)).toBeGreaterThan(glide(0) * 1.2);
    });
  });
});
