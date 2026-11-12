import * as THREE from 'three';
import { PlaneState, emptyInput, type ControlInput, type Gear, type PlaneSpec } from './flight';
import { composeSpec, gearFor, type Livery, type Loadout } from './loadout';
import { PlaneVisual } from './planeMesh';

/** A plane entity: simulation state + visual, built from a hangar Loadout. */
export class Plane {
  readonly s = new PlaneState();
  readonly prevPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly input: ControlInput = emptyInput();
  readonly visual: PlaneVisual;
  readonly gear: Gear;
  spec: PlaneSpec;
  /** out of control (still falling) */
  downed = false;
  /** hit the ground / exploded; no longer simulated */
  wrecked = false;
  downedSide = 1;
  smokeT = 0;
  dustT = 0;

  constructor(
    readonly loadout: Loadout,
    toon: THREE.Material,
    outline: THREE.Material,
    spec: PlaneSpec = composeSpec(loadout),
  ) {
    this.spec = spec;
    this.gear = gearFor(loadout);
    this.visual = new PlaneVisual(loadout, toon, outline);
  }

  get livery(): Livery {
    return this.visual.livery;
  }

  get alive() {
    return !this.downed && !this.wrecked;
  }

  forward(out: THREE.Vector3) {
    return out.set(0, 0, -1).applyQuaternion(this.s.quat);
  }
  up(out: THREE.Vector3) {
    return out.set(0, 1, 0).applyQuaternion(this.s.quat);
  }

  savePrev() {
    this.prevPos.copy(this.s.pos);
    this.prevQuat.copy(this.s.quat);
  }

  teleport() {
    this.savePrev();
  }

  syncVisual(alpha: number, dt: number) {
    const r = this.visual.root;
    r.position.lerpVectors(this.prevPos, this.s.pos, alpha);
    r.quaternion.slerpQuaternions(this.prevQuat, this.s.quat, alpha);
    this.visual.animate(dt, this.input.pitch, this.input.roll, this.input.yaw, this.s.rpm);
  }

  /** Overall health 0..1 for HUD / scoring. */
  get integrity() {
    const h = this.s.health;
    return Math.min(h.engine, h.wings, h.tail, h.pilot);
  }
}
