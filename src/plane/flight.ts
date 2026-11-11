import * as THREE from 'three';

/**
 * Flight model (design §3, ADR "Custom arcade flight physics").
 * Simplified force-based model run at a fixed step:
 *  - forces: thrust, lift (with soft stall), drag (parasitic + induced +
 *    flat-plate), side force, gravity, gear spring-dampers + friction;
 *  - rotation: control-surface accelerations scaled by dynamic pressure,
 *    aerodynamic damping and weathervane stability, plus gear torques.
 * Axes: body forward = -Z, up = +Y, right = +X. Positive angVel.x = nose up,
 * positive angVel.y = nose left, positive angVel.z = roll left.
 * All constants live in PlaneSpec (data, tunable live with ?debug).
 */
export interface PlaneSpec {
  mass: number;
  wingArea: number;
  rho: number;
  cl0: number;
  clSlope: number;
  stallAlpha: number;
  alphaTrim: number;
  cd0: number;
  inducedK: number;
  sideArea: number;
  cyBeta: number;
  maxThrust: number;
  propVmax: number;
  pitchAcc: number;
  rollAcc: number;
  yawAcc: number;
  pitchDamp: number;
  rollDamp: number;
  yawDamp: number;
  pitchStab: number;
  yawStab: number;
  qRef: number;
  inertiaPitch: number;
  inertiaYaw: number;
  inertiaRoll: number;
  gearK: number;
  gearC: number;
  rollFriction: number;
  brakeFriction: number;
  skidFriction: number;
  groundSteer: number;
  crashSpeed: number;
  ammo: number;
}

export const DEFAULT_SPEC: PlaneSpec = {
  mass: 650,
  wingArea: 21.5,
  rho: 1.2,
  cl0: 0.12,
  clSlope: 4.6,
  stallAlpha: 0.27,
  alphaTrim: 0.03,
  cd0: 0.035,
  inducedK: 0.075,
  sideArea: 6,
  cyBeta: 1.2,
  maxThrust: 2600,
  propVmax: 95,
  pitchAcc: 5.5,
  rollAcc: 9,
  yawAcc: 2.4,
  pitchDamp: 3.2,
  rollDamp: 4,
  yawDamp: 2.6,
  pitchStab: 9,
  yawStab: 5,
  qRef: 735,
  inertiaPitch: 1100,
  inertiaYaw: 1500,
  inertiaRoll: 800,
  gearK: 70000,
  gearC: 6000,
  rollFriction: 0.03,
  brakeFriction: 0.45,
  skidFriction: 0.3,
  groundSteer: 1.6,
  crashSpeed: 6,
  ammo: 600,
};

export interface ControlInput {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  fire: boolean;
  brake: boolean;
}

export const emptyInput = (): ControlInput => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, fire: false, brake: false });

export interface Health {
  engine: number;
  wings: number;
  tail: number;
  pilot: number;
}

export class PlaneState {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  quat = new THREE.Quaternion();
  angVel = new THREE.Vector3();
  throttle = 0;
  rpm = 0;
  wheels = 0;
  onGround = false;
  airTime = 0;
  groundTime = 0;
  alpha = 0;
  beta = 0;
  airspeed = 0;
  stalled = false;
  health: Health = { engine: 1, wings: 1, tail: 1, pilot: 1 };
  ammo = 600;
  gunHeat = 0;
  overheated = false;
  t = 0;
  /** world-space vertical speed just before the latest wheel contact */
  lastSink = 0;
}

export interface Env {
  /** Terrain height at x/z (no sea). */
  groundHeight(x: number, z: number): number;
  wind: THREE.Vector3;
}

export interface StepEvents {
  crashed: string | null;
  touchdown: { sink: number; bank: number; speed: number } | null;
  propStrike: boolean;
  scrape: boolean;
  splash: boolean;
}

// contact geometry (body space)
export const WHEELS = [new THREE.Vector3(-0.92, -1.36, -0.6), new THREE.Vector3(0.92, -1.36, -0.6)];
export const TAIL_SKID = new THREE.Vector3(0, -0.22, 3.85);
const CRASH_POINTS: { p: THREE.Vector3; kind: 'wing' | 'nose' | 'top' | 'prop' }[] = [
  { p: new THREE.Vector3(-4.0, -0.45, -0.55), kind: 'wing' },
  { p: new THREE.Vector3(4.0, -0.45, -0.55), kind: 'wing' },
  { p: new THREE.Vector3(-4.3, 1.5, -1.0), kind: 'wing' },
  { p: new THREE.Vector3(4.3, 1.5, -1.0), kind: 'wing' },
  { p: new THREE.Vector3(0, 0.05, -3.0), kind: 'nose' },
  { p: new THREE.Vector3(0, -1.2, -2.95), kind: 'prop' },
  { p: new THREE.Vector3(0, 1.65, -1.0), kind: 'top' },
  { p: new THREE.Vector3(0, 1.2, 4.1), kind: 'top' },
];

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _air = new THREE.Vector3();
const _loc = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _lift = new THREE.Vector3();
const _F = new THREE.Vector3();
const _tauW = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _r = new THREE.Vector3();
const _pw = new THREE.Vector3();
const _wW = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _hf = new THREE.Vector3();
const _hl = new THREE.Vector3();
const _Fc = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _rh = new THREE.Vector3();

export function liftCoefficient(spec: PlaneSpec, a: number): number {
  const aS = spec.stallAlpha;
  const plate = 1.05 * Math.sin(2 * a);
  if (a > aS) {
    const peak = spec.cl0 + spec.clSlope * aS;
    const t = Math.min((a - aS) / 0.15, 1);
    return peak * (1 - t) + plate * t;
  }
  const aN = -aS * 0.85;
  if (a < aN) {
    const peak = spec.cl0 + spec.clSlope * aN;
    const t = Math.min((aN - a) / 0.15, 1);
    return peak * (1 - t) + plate * t;
  }
  return spec.cl0 + spec.clSlope * a;
}

/** Advance one plane by dt. Mutates state, returns events. */
export function stepFlight(s: PlaneState, spec: PlaneSpec, input: ControlInput, env: Env, dt: number): StepEvents {
  const ev: StepEvents = { crashed: null, touchdown: null, propStrike: false, scrape: false, splash: false };
  const h = s.health;
  s.t += dt;

  _fwd.set(0, 0, -1).applyQuaternion(s.quat);
  _up.set(0, 1, 0).applyQuaternion(s.quat);
  _right.set(1, 0, 0).applyQuaternion(s.quat);
  _qInv.copy(s.quat).invert();

  // engine
  s.throttle = THREE.MathUtils.clamp(input.throttle, 0, 1);
  let target = h.engine > 0 ? s.throttle : 0;
  if (h.engine > 0 && h.engine < 0.3) target *= 0.55 + 0.45 * Math.abs(Math.sin(s.t * 7.3) * Math.sin(s.t * 2.1));
  s.rpm += (target - s.rpm) * Math.min(1, dt * 1.6);

  // air-relative velocity
  _air.copy(s.vel).sub(env.wind);
  const V = _air.length();
  _loc.copy(_air).applyQuaternion(_qInv);
  const u = -_loc.z;
  s.airspeed = V;
  s.alpha = Math.atan2(-_loc.y, Math.max(Math.abs(u), 0.5) * Math.sign(u || 1));
  s.beta = Math.atan2(_loc.x, Math.max(Math.abs(u), 1));
  s.stalled = s.alpha > spec.stallAlpha && V > 3;
  const qd = 0.5 * spec.rho * V * V;

  _F.set(0, 0, 0);
  if (V > 0.5) {
    _dir.copy(_air).divideScalar(V);
    const cl = liftCoefficient(spec, s.alpha) * (0.45 + 0.55 * h.wings);
    const sa = Math.sin(s.alpha);
    const cd = spec.cd0 * (1 + (1 - h.wings) * 1.5) + spec.inducedK * cl * cl + 1.1 * sa * sa;
    _lift.crossVectors(_right, _dir);
    const ll = _lift.length();
    if (ll > 1e-4) _F.addScaledVector(_lift.divideScalar(ll), qd * spec.wingArea * cl);
    _F.addScaledVector(_dir, -qd * spec.wingArea * cd);
    _F.addScaledVector(_right, -qd * spec.sideArea * spec.cyBeta * s.beta);
  }
  const thrust = s.rpm * spec.maxThrust * Math.max(0, 1 - Math.max(u, 0) / spec.propVmax) * (h.engine > 0 ? 0.3 + 0.7 * h.engine : 0);
  _F.addScaledVector(_fwd, thrust);
  _F.y -= spec.mass * 9.81;

  // rotational accelerations from aerodynamics (body frame)
  const e = Math.min(qd / spec.qRef, 1.6);
  const tailEff = 0.35 + 0.65 * h.tail;
  const av = s.angVel;
  const aC = THREE.MathUtils.clamp(s.alpha - spec.alphaTrim, -0.6, 0.6);
  const bC = THREE.MathUtils.clamp(s.beta, -0.6, 0.6);
  _acc.set(
    input.pitch * spec.pitchAcc * e * tailEff - av.x * spec.pitchDamp * (0.3 + e) - aC * spec.pitchStab * e,
    -input.yaw * spec.yawAcc * e * tailEff - av.y * spec.yawDamp * (0.3 + e) - bC * spec.yawStab * e,
    -input.roll * spec.rollAcc * e * (0.4 + 0.6 * h.wings) - av.z * spec.rollDamp * (0.3 + e) + (1 - h.wings) * 1.2 * e,
  );
  if (s.stalled) _acc.z += Math.sin(s.t * 1.7) * 2.2 * Math.min(e, 1);

  // ground contact: wheels + tail skid
  const lowEnough = s.pos.y - env.groundHeight(s.pos.x, s.pos.z) < 8;
  const wasWheels = s.wheels;
  s.wheels = 0;
  _tauW.set(0, 0, 0);
  let splashed = false;
  if (lowEnough) {
    _wW.copy(av).applyQuaternion(s.quat);
    _hf.set(_fwd.x, 0, _fwd.z);
    if (_hf.lengthSq() < 1e-6) _hf.set(0, 0, -1);
    _hf.normalize();
    _hl.set(-_hf.z, 0, _hf.x);
    const contact = (local: THREE.Vector3, mu: number) => {
      _r.copy(local).applyQuaternion(s.quat);
      _pw.copy(s.pos).add(_r);
      const terrain = env.groundHeight(_pw.x, _pw.z);
      const surf = Math.max(terrain, 0);
      const pen = surf - _pw.y;
      if (pen <= 0) return false;
      if (terrain < -0.3) splashed = true;
      _vp.crossVectors(_wW, _r).add(s.vel);
      const fn = Math.max(0, spec.gearK * pen - spec.gearC * _vp.y);
      const vLong = _vp.dot(_hf);
      const vLat = _vp.dot(_hl);
      const fLong = -THREE.MathUtils.clamp(vLong * 3000, -mu * fn, mu * fn);
      const fLat = -THREE.MathUtils.clamp(vLat * 4000, -0.9 * fn, 0.9 * fn);
      _Fc.set(0, fn, 0).addScaledVector(_hf, fLong);
      _F.add(_Fc);
      _tauW.add(_tmp.crossVectors(_r, _Fc));
      // side friction acts through a horizontal lever only (yaw, no tip-over roll)
      _Fc.copy(_hl).multiplyScalar(fLat);
      _F.add(_Fc);
      _rh.set(_r.x, 0, _r.z);
      _tauW.add(_tmp.crossVectors(_rh, _Fc));
      return true;
    };
    const mu = input.brake ? spec.brakeFriction : spec.rollFriction;
    for (const w of WHEELS) if (contact(w, mu)) s.wheels++;
    const tail = contact(TAIL_SKID, spec.skidFriction);
    if (tail) s.wheels++;

    // crash / scrape points
    for (const c of CRASH_POINTS) {
      _r.copy(c.p).applyQuaternion(s.quat);
      _pw.copy(s.pos).add(_r);
      const terrain = env.groundHeight(_pw.x, _pw.z);
      const surf = Math.max(terrain, 0);
      if (_pw.y >= surf) continue;
      if (terrain < -0.3) splashed = true;
      _vp.crossVectors(_wW, _r).add(s.vel);
      const impact = _vp.length();
      if (c.kind === 'prop') {
        if (s.rpm > 0.15) ev.propStrike = true;
        if (impact > spec.crashSpeed * 2) ev.crashed = 'Nosed over';
        contact(c.p, 0.6);
        continue;
      }
      if (c.kind === 'top') {
        ev.crashed = 'Flipped over';
        continue;
      }
      if (c.kind === 'nose' && impact > spec.crashSpeed) ev.crashed = 'Nosed in';
      else if (c.kind === 'wing' && (-_vp.y > spec.crashSpeed * 0.6 || impact > spec.crashSpeed * 3)) ev.crashed = 'Cartwheeled';
      else {
        ev.scrape = true;
        contact(c.p, 0.7);
      }
    }
    if (splashed && (s.wheels > 0 || ev.scrape || ev.crashed)) {
      ev.splash = true;
      ev.crashed = 'Ditched in the water';
    }

    if (s.wheels > 0) {
      _tmp.copy(_tauW).applyQuaternion(_qInv);
      _acc.x += _tmp.x / spec.inertiaPitch;
      _acc.y += _tmp.y / spec.inertiaYaw;
      _acc.z += _tmp.z / spec.inertiaRoll;
      // arcade gear stability: no ground loops, wings stay level on the gear
      const bank = Math.atan2(_right.y, _up.y);
      _acc.y += bC * spec.yawStab * e * 0.75 - av.y * 3.5;
      _acc.z += -av.z * 4 - bank * 12;
      // tail-wheel / differential steering
      const gs = Math.hypot(s.vel.x, s.vel.z);
      _acc.y += -(input.yaw + input.roll * 0.6) * spec.groundSteer * Math.min(gs / 4, 1) * Math.max(0, 1 - gs / 40);
    }
  }
  if (s.wheels > 0 && wasWheels === 0 && s.airTime > 0.6) {
    const bank = Math.abs(Math.atan2(_right.y, _up.y));
    ev.touchdown = { sink: Math.max(0, -s.lastSink), bank, speed: V };
  }
  if (s.wheels === 0) s.lastSink = s.vel.y;

  // integrate (semi-implicit Euler)
  s.vel.addScaledVector(_F, dt / spec.mass);
  s.pos.addScaledVector(s.vel, dt);
  av.addScaledVector(_acc, dt);
  av.clampScalar(-5, 5);
  _tmp.copy(av).multiplyScalar(dt);
  const ang = _tmp.length();
  if (ang > 1e-9) {
    _dq.setFromAxisAngle(_tmp.divideScalar(ang), ang);
    s.quat.multiply(_dq).normalize();
  }

  // tunnelling safety
  const gNow = env.groundHeight(s.pos.x, s.pos.z);
  if (s.pos.y < Math.max(gNow, 0) - 1.5) ev.crashed = ev.crashed ?? (gNow < 0 ? 'Ditched in the water' : 'Hit the ground');

  s.onGround = s.wheels > 0;
  if (s.onGround) {
    s.groundTime += dt;
    s.airTime = 0;
  } else {
    s.airTime += dt;
    s.groundTime = 0;
  }
  return ev;
}

/** Orientation for a plane sitting on its gear, nose along heading dir (xz). */
export function groundAttitude(dirX: number, dirZ: number): THREE.Quaternion {
  const fwd = new THREE.Vector3(dirX, 0, dirZ).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
  const m = new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate());
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  // pitch nose-up so wheels and tail skid both touch
  const dz = TAIL_SKID.z - WHEELS[0].z;
  const dy = TAIL_SKID.y - WHEELS[0].y;
  const pitch = Math.atan2(dy, dz);
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
  return q;
}

/** Height of the plane origin above ground when resting on its gear. */
export function restHeight(q: THREE.Quaternion): number {
  const w = WHEELS[0].clone().applyQuaternion(q);
  return -w.y - 0.02;
}
