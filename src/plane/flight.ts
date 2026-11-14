import * as THREE from 'three';

/**
 * Flight model (design §3, ADR "Custom arcade flight physics").
 * Simplified force-based model run at a fixed step:
 *  - forces: thrust, lift (with soft stall), drag (parasitic + induced +
 *    flat-plate), side force, gravity, gear spring-dampers + friction;
 *  - rotation: control-surface accelerations scaled by dynamic pressure,
 *    aerodynamic damping and weathervane stability, plus gear torques;
 *  - flaps (plan step 24): more lift and drag for take-off and landing,
 *    blown back by the airflow above the plane's flap speed.
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
  /** engine RPM response rate (1/s): prop fast, jet slow to spool */
  spoolRate: number;
  /** wheel grip multipliers per surface (tyre choice, design §8.2) */
  gripPaved: number;
  gripGrass: number;
  /** flaps: extra lift coefficient at full flap */
  flapCl: number;
  /** flaps: extra drag coefficient at full flap (grows with the square of the deflection) */
  flapCd: number;
  /** flaps: the wing stalls this much earlier (rad) at full flap */
  flapStall: number;
  /** flaps: the trimmed angle of attack drops this much at full flap (less ballooning) */
  flapTrim: number;
  /** flaps: travel per second (0..1) */
  flapRate: number;
  /** flaps: full flap allowed up to this airspeed (m/s); blown back to none at 1.3× */
  flapSpeed: number;
}

/** Flap notches: up, take-off, landing (fraction of full deflection). */
export const FLAP_NOTCHES = [0, 0.5, 1];
export const FLAP_LABELS = ['UP', 'T/O', 'LAND'];
/** Visual deflection at full flap (rad). */
export const FLAP_MAX_ANGLE = 0.61;

/**
 * Landing forgiveness: touchdown crash limits and landing grades are this much
 * more tolerant than the raw tyre crash speed (tuned to make landing ~15% easier).
 */
export const LANDING_FORGIVENESS = 1.15;

/** Extra strut damping while the gear extends again after a touchdown (cuts bounce height ~30%). */
export const REBOUND_DAMPING = 2;

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
  maxThrust: 3250, // +25% over the original 2600 N
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
  gearC: 6900, // +15% damping: firm touchdowns bounce less
  rollFriction: 0.03,
  brakeFriction: 0.495, // +10% bite (was 0.45)
  skidFriction: 0.3,
  groundSteer: 1.6,
  crashSpeed: 6,
  spoolRate: 1.6,
  gripPaved: 1,
  gripGrass: 1,
  flapCl: 0.6,
  flapCd: 0.07,
  flapStall: 0.02,
  flapTrim: 0.03,
  flapRate: 0.6,
  flapSpeed: 30,
};

export interface ControlInput {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  brake: boolean;
  /** flap lever 0..1 (see FLAP_NOTCHES) */
  flaps: number;
}

export const emptyInput = (): ControlInput => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: false, flaps: 0 });

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
  t = 0;
  /** world-space vertical speed just before the latest wheel contact */
  lastSink = 0;
  /** flap position 0..1 (moves toward the lever at flapRate) */
  flaps = 0;
  /** the airflow is holding the flaps short of the lever (too fast for flaps) */
  flapsBlown = false;
}

export type Surface = 'paved' | 'grass' | 'rough' | 'water';

export interface Env {
  /** Terrain height at x/z (no sea). */
  groundHeight(x: number, z: number): number;
  /** What the wheels roll on; grass when absent. */
  surfaceAt?(x: number, z: number): Surface;
  wind: THREE.Vector3;
}

export interface StepEvents {
  crashed: string | null;
  touchdown: { sink: number; bank: number; speed: number } | null;
  propStrike: boolean;
  scrape: boolean;
  splash: boolean;
}

/** Contact geometry (body space) of one airframe + wheels + engine (design §8). */
export interface Gear {
  /** main wheel contact points */
  wheels: THREE.Vector3[];
  /** tail skid (taildragger) or nose wheel contact (tricycle) */
  third: THREE.Vector3;
  tricycle: boolean;
  crash: { p: THREE.Vector3; kind: 'wing' | 'nose' | 'top' | 'prop' | 'tail' }[];
}

// default contact geometry: the original biplane with medium wheels
export const WHEELS = [new THREE.Vector3(-0.92, -1.36, -0.6), new THREE.Vector3(0.92, -1.36, -0.6)];
export const TAIL_SKID = new THREE.Vector3(0, -0.22, 3.85);
const CRASH_POINTS: Gear['crash'] = [
  { p: new THREE.Vector3(-4.0, -0.45, -0.55), kind: 'wing' },
  { p: new THREE.Vector3(4.0, -0.45, -0.55), kind: 'wing' },
  { p: new THREE.Vector3(-4.3, 1.5, -1.0), kind: 'wing' },
  { p: new THREE.Vector3(4.3, 1.5, -1.0), kind: 'wing' },
  { p: new THREE.Vector3(0, 0.05, -3.0), kind: 'nose' },
  { p: new THREE.Vector3(0, -1.2, -2.95), kind: 'prop' },
  { p: new THREE.Vector3(0, 1.65, -1.0), kind: 'top' },
  { p: new THREE.Vector3(0, 1.2, 4.1), kind: 'top' },
];
export const DEFAULT_GEAR: Gear = { wheels: WHEELS, third: TAIL_SKID, tricycle: false, crash: CRASH_POINTS };

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

/** Stall angle of attack with the flaps at `flaps` (0..1). */
export function stallAlphaAt(spec: PlaneSpec, flaps: number): number {
  return spec.stallAlpha - spec.flapStall * flaps;
}

export function liftCoefficient(spec: PlaneSpec, a: number, flaps = 0): number {
  const aS = stallAlphaAt(spec, flaps);
  const cl0 = spec.cl0 + spec.flapCl * flaps;
  const plate = 1.05 * Math.sin(2 * a);
  if (a > aS) {
    const peak = cl0 + spec.clSlope * aS;
    const t = Math.min((a - aS) / 0.15, 1);
    return peak * (1 - t) + plate * t;
  }
  const aN = -spec.stallAlpha * 0.85;
  if (a < aN) {
    const peak = cl0 + spec.clSlope * aN;
    const t = Math.min((aN - a) / 0.15, 1);
    return peak * (1 - t) + plate * t;
  }
  return cl0 + spec.clSlope * a;
}

/** Advance one plane by dt. Mutates state, returns events. */
export function stepFlight(s: PlaneState, spec: PlaneSpec, input: ControlInput, env: Env, dt: number, gear: Gear = DEFAULT_GEAR): StepEvents {
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
  s.rpm += (target - s.rpm) * Math.min(1, dt * spec.spoolRate);

  // air-relative velocity
  _air.copy(s.vel).sub(env.wind);
  const V = _air.length();
  _loc.copy(_air).applyQuaternion(_qInv);
  const u = -_loc.z;
  s.airspeed = V;
  s.alpha = Math.atan2(-_loc.y, Math.max(Math.abs(u), 0.5) * Math.sign(u || 1));
  s.beta = Math.atan2(_loc.x, Math.max(Math.abs(u), 1));
  // flaps follow the lever, but the airflow blows them back above the flap speed
  const allowed = THREE.MathUtils.clamp(1 - (V - spec.flapSpeed) / (0.3 * spec.flapSpeed), 0, 1);
  const flapTarget = Math.min(THREE.MathUtils.clamp(input.flaps, 0, 1), allowed);
  s.flapsBlown = input.flaps > allowed + 0.01;
  const fStep = spec.flapRate * dt;
  s.flaps += THREE.MathUtils.clamp(flapTarget - s.flaps, -fStep, fStep);
  // blow-back is quicker than the motor
  if (s.flaps > allowed) s.flaps = Math.max(allowed, s.flaps - fStep * 2);
  const fl = s.flaps;
  s.stalled = s.alpha > stallAlphaAt(spec, fl) && V > 3;
  const qd = 0.5 * spec.rho * V * V;

  _F.set(0, 0, 0);
  if (V > 0.5) {
    _dir.copy(_air).divideScalar(V);
    const cl = liftCoefficient(spec, s.alpha, fl) * (0.45 + 0.55 * h.wings);
    const sa = Math.sin(s.alpha);
    const cd = spec.cd0 * (1 + (1 - h.wings) * 1.5) + spec.flapCd * fl * fl + spec.inducedK * cl * cl + 1.1 * sa * sa;
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
  const aC = THREE.MathUtils.clamp(s.alpha - (spec.alphaTrim - spec.flapTrim * fl), -0.6, 0.6);
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
    // friction coefficient for a rolling wheel at _pw (set by contact())
    const wheelMu = (braking: boolean) => {
      const surf = env.surfaceAt ? env.surfaceAt(_pw.x, _pw.z) : 'grass';
      const grip = surf === 'paved' ? spec.gripPaved : spec.gripGrass * (surf === 'rough' ? 0.85 : 1);
      if (braking) return spec.brakeFriction * grip;
      const roll = surf === 'paved' ? 0.7 : surf === 'rough' ? 1.6 : 1;
      return (spec.rollFriction * roll) / grip;
    };
    const contact = (local: THREE.Vector3, mu: number | 'wheel' | 'brake') => {
      _r.copy(local).applyQuaternion(s.quat);
      _pw.copy(s.pos).add(_r);
      const terrain = env.groundHeight(_pw.x, _pw.z);
      const surf = Math.max(terrain, 0);
      const pen = surf - _pw.y;
      if (pen <= 0) return false;
      if (terrain < -0.3) splashed = true;
      if (typeof mu !== 'number') mu = wheelMu(mu === 'brake');
      _vp.crossVectors(_wW, _r).add(s.vel);
      // oleo-style strut: rebound (extension, _vp.y > 0) is damped harder than
      // compression, so a firm touchdown settles instead of bouncing back up
      const damp = _vp.y > 0 ? spec.gearC * REBOUND_DAMPING : spec.gearC;
      const fn = Math.max(0, spec.gearK * pen - damp * _vp.y);
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
    const mains = input.brake ? 'brake' : 'wheel';
    for (const w of gear.wheels) if (contact(w, mains)) s.wheels++;
    // a nose wheel rolls (no brake); a tail skid drags
    const tail = contact(gear.third, gear.tricycle ? 'wheel' : spec.skidFriction);
    if (tail) s.wheels++;

    // crash / scrape points
    const tol = spec.crashSpeed * LANDING_FORGIVENESS;
    for (const c of gear.crash) {
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
        if (impact > tol * 2) ev.crashed = 'Nosed over';
        contact(c.p, 0.6);
        continue;
      }
      if (c.kind === 'top') {
        ev.crashed = 'Flipped over';
        continue;
      }
      if (c.kind === 'tail') {
        // tail strike on rotation or flare: scrape, crash only when slammed
        if (-_vp.y > tol * 1.5) ev.crashed = 'Tail strike';
        ev.scrape = true;
        contact(c.p, 0.5);
        continue;
      }
      if (c.kind === 'nose' && impact > tol) ev.crashed = 'Nosed in';
      else if (c.kind === 'wing' && (-_vp.y > tol * 0.6 || impact > tol * 3)) ev.crashed = 'Cartwheeled';
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
export function groundAttitude(dirX: number, dirZ: number, gear: Gear = DEFAULT_GEAR): THREE.Quaternion {
  const fwd = new THREE.Vector3(dirX, 0, dirZ).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
  const m = new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate());
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  // pitch so the main wheels and the tail skid / nose wheel all touch
  const dz = gear.third.z - gear.wheels[0].z;
  const dy = gear.third.y - gear.wheels[0].y;
  const pitch = Math.atan(dy / dz);
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
  return q;
}

/** Height of the plane origin above ground when resting on its gear. */
export function restHeight(q: THREE.Quaternion, gear: Gear = DEFAULT_GEAR): number {
  const w = gear.wheels[0].clone().applyQuaternion(q);
  return -w.y - 0.02;
}
