import * as THREE from 'three';
import type { PlaneState } from './flight';

/** Bank angle helper used by the player's flight assists. */
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();

export function bankAngle(s: PlaneState): number {
  _r.set(1, 0, 0).applyQuaternion(s.quat);
  _u.set(0, 1, 0).applyQuaternion(s.quat);
  // positive = right wing up (banked left); rolling right reduces it
  return Math.atan2(_r.y, _u.y);
}
