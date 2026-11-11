import * as THREE from 'three';
import type { ControlInput, PlaneSpec, PlaneState } from './flight';

/**
 * Bank-to-turn steering toward a world direction. Used by the enemy pilots
 * (design §3 "Enemy AI pilots", PD controller on desired heading) and by the
 * player's flight assists.
 */
const _q = new THREE.Quaternion();
const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();

export function bankAngle(s: PlaneState): number {
  _r.set(1, 0, 0).applyQuaternion(s.quat);
  _u.set(0, 1, 0).applyQuaternion(s.quat);
  // positive = right wing up (banked left); rolling right reduces it
  return Math.atan2(_r.y, _u.y);
}

export function steerToward(s: PlaneState, spec: PlaneSpec, dir: THREE.Vector3, out: ControlInput, pull = 1, maxBank = Math.PI) {
  _q.copy(s.quat).invert();
  _d.copy(dir).normalize().applyQuaternion(_q);
  const fwdDot = -_d.z;
  const off = Math.acos(THREE.MathUtils.clamp(fwdDot, -1, 1));
  const level = bankAngle(s);
  const toTarget = Math.atan2(_d.x, _d.y);
  const w = THREE.MathUtils.smoothstep(off, 0.04, 0.3);
  const rollErr = w * toTarget + (1 - w) * level * 0.8;
  let rollCmd = rollErr;
  // bank limit (e.g. near the ground): never roll further past maxBank
  if (Math.abs(level) > maxBank && Math.sign(rollErr) !== Math.sign(level)) rollCmd = (Math.abs(level) - maxBank) * Math.sign(level) * 2;
  out.roll = THREE.MathUtils.clamp(rollCmd * 2.2 + s.angVel.z * 0.35, -1, 1);
  const pitchErr = Math.atan2(_d.y, Math.max(fwdDot, 0.05));
  const aligned = THREE.MathUtils.clamp(1 - Math.abs(rollErr) / 1.3, 0, 1);
  // energy management: don't haul the stick back when slow
  const energy = THREE.MathUtils.clamp((s.airspeed - 22) / 14, 0.25, 1);
  out.pitch = THREE.MathUtils.clamp((pitchErr * 3.2 * (w > 0.5 ? aligned : 1) - s.angVel.x * 0.3) * pull, -1, 1);
  if (out.pitch > 0) out.pitch *= energy;
  out.yaw = THREE.MathUtils.clamp(_d.x * 4, -1, 1) * (1 - w);
  if (s.alpha > spec.stallAlpha * 0.85 && out.pitch > 0) out.pitch *= 0.3;
}
