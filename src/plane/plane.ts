import * as THREE from 'three';
import { BiplaneVisual, type Livery } from './biplaneMesh';
import { DEFAULT_SPEC, PlaneState, emptyInput, type ControlInput, type PlaneSpec } from './flight';
import type { AIPilot } from '../combat/ai';

/** A plane entity: simulation state + visual + combat bookkeeping. */
export type Team = 'player' | 'enemy';

export const MUZZLES = [new THREE.Vector3(-0.22, 0.68, -1.95), new THREE.Vector3(0.22, 0.68, -1.95)];

let nextId = 1;

export class Plane {
  readonly id = nextId++;
  readonly s = new PlaneState();
  readonly prevPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly input: ControlInput = emptyInput();
  readonly visual: BiplaneVisual;
  spec: PlaneSpec;
  ai: AIPilot | null = null;
  /** shot down / out of control (still falling) */
  downed = false;
  /** hit the ground / exploded; no longer simulated */
  wrecked = false;
  wreckT = 0;
  downedSide = 1;
  gunCooldown = 0;
  gunSide = 0;
  shots = 0;
  hits = 0;
  kills = 0;
  damageTaken = 0;
  smokeT = 0;
  dustT = 0;
  lastAttacker: Plane | null = null;

  constructor(
    readonly team: Team,
    livery: Livery,
    toon: THREE.Material,
    outline: THREE.Material,
    spec: PlaneSpec = DEFAULT_SPEC,
  ) {
    this.spec = spec;
    this.s.ammo = spec.ammo;
    this.visual = new BiplaneVisual(livery, toon, outline);
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
