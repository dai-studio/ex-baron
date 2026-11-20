import * as THREE from 'three';
import { addOutlineNormals } from '../render/geo';
import { outlineMaterial } from '../render/outline';
import { toonMaterial } from '../render/toon';

/**
 * Skywriting smoke (plan step 52): toon puffs with ink outlines that stay for
 * the whole sortie, unlike the short-lived effect particles. Each puff grows
 * from a wisp at the tail to its full size in a few seconds, then keeps
 * spreading slowly. Not fogged, so the whole message stays readable from far
 * away. A ring buffer: the oldest puffs go first if the cap is reached.
 */
const MAX = 5000;
const GROW = 3; // s to reach the full size
const SPREAD = 240; // s to spread another 40%

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class SkySmoke {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private outline: THREE.InstancedMesh;
  private pos = new Float32Array(MAX * 3);
  private born = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private rot = new Float32Array(MAX);
  private n = 0;
  private head = 0;
  private time = 0;

  constructor() {
    const g = new THREE.IcosahedronGeometry(1, 1);
    addOutlineNormals(g);
    const mat = toonMaterial({ color: 0xffffff, rim: 0.12, fog: false });
    const ink = outlineMaterial(0x2b1d1a, 0.9, 1200);
    ink.fog = false;
    this.mesh = new THREE.InstancedMesh(g, mat, MAX);
    this.outline = new THREE.InstancedMesh(g, ink, MAX);
    this.outline.instanceMatrix = this.mesh.instanceMatrix;
    for (const m of [this.mesh, this.outline]) {
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.group.name = 'skysmoke';
  }

  get count() {
    return this.n;
  }

  clear() {
    this.n = 0;
    this.head = 0;
    this.time = 0;
    this.mesh.count = this.outline.count = 0;
  }

  /** Release one puff at `p` that grows to `size` (radius, m). */
  add(p: THREE.Vector3, size: number) {
    const i = this.head;
    this.head = (this.head + 1) % MAX;
    this.n = Math.min(MAX, this.n + 1);
    const j = size * 0.15;
    this.pos[i * 3] = p.x + (Math.random() - 0.5) * j;
    this.pos[i * 3 + 1] = p.y + (Math.random() - 0.5) * j;
    this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * j;
    this.born[i] = this.time;
    this.size[i] = size * (0.85 + Math.random() * 0.3);
    this.rot[i] = Math.random() * 6.28;
  }

  update(dt: number, cam: THREE.Vector3) {
    this.time += dt;
    for (let i = 0; i < this.n; i++) {
      const age = this.time - this.born[i];
      const grow = age < GROW ? 0.08 + 0.92 * Math.sqrt(age / GROW) : 1 + 0.4 * Math.min(1, (age - GROW) / SPREAD);
      let size = this.size[i] * grow;
      _p.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      // never let a puff swallow the camera (its ink hull would fill the screen)
      const d = _p.distanceTo(cam);
      if (d < size * 2.5 + 1) size *= THREE.MathUtils.clamp((d - 1) / (size * 2.5), 0, 1);
      _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.rot[i]);
      size = Math.max(size, 0.001);
      _m.compose(_p, _q, _s.set(size, size * 0.85, size));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = this.outline.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    (this.outline.material as THREE.Material).dispose();
  }
}
