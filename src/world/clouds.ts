import * as THREE from 'three';
import { addOutlineNormals } from '../render/geo';
import { outlineMaterial } from '../render/outline';
import { toonMaterial } from '../render/toon';
import { Simplex2 } from './noise';
import { hash32, mulberry32 } from './rng';

/**
 * Procedural clouds (design §4) rendered as toon clouds (design §5):
 * cumulus = clusters of puffy low-poly blobs placed per 1.6 km cell from the
 * seed, drifting with the wind. One InstancedMesh + one outline for all.
 * Cloud bases sit 200-460 m above the local ground, low enough to fly through.
 */
const BASE_MIN = 200;
const BASE_RANGE = 260;
/*
 */
const CELL = 1600;
const MAX = 5000;

export type CloudCover = 'clear' | 'fair' | 'overcast';

export class Clouds {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private outline: THREE.InstancedMesh;
  private noise: Simplex2;
  /** active sphere list in cloud-local space: x, y, z, r */
  private spheres = new Float32Array(MAX * 4);
  private count = 0;
  private lastCell = { x: 1e9, z: 1e9 };
  private drift = new THREE.Vector3();
  private cover: number;
  radiusCells = 5;

  constructor(
    private seed: number,
    cover: CloudCover,
    /** terrain height (m) under a point, so cloud bases follow the ground */
    private ground: (x: number, z: number) => number = () => 0,
  ) {
    this.noise = new Simplex2(hash32(seed, 555));
    this.cover = cover === 'clear' ? -0.45 : cover === 'overcast' ? 0.45 : 0;
    const geo = new THREE.IcosahedronGeometry(1, 1);
    addOutlineNormals(geo);
    const mat = toonMaterial({ color: 0xffffff, ramp: [196, 236, 255], rim: 0.12 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.outline = new THREE.InstancedMesh(geo, outlineMaterial(0x8fa3c7, 1.2, 2500), MAX);
    this.outline.instanceMatrix = this.mesh.instanceMatrix;
    this.outline.count = 0;
    this.outline.frustumCulled = false;
    this.group.add(this.mesh, this.outline);
    this.group.name = 'clouds';
  }

  private build(ccx: number, ccz: number) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    let n = 0;
    const R = this.radiusCells;
    for (let j = -R; j <= R; j++)
      for (let i = -R; i <= R; i++) {
        if (i * i + j * j > (R + 0.5) * (R + 0.5)) continue;
        const cx = ccx + i;
        const cz = ccz + j;
        const r = mulberry32(hash32(this.seed, cx, cz, 777));
        const cov = this.noise.noise(cx * 0.31, cz * 0.31) + this.cover;
        const clouds = Math.max(0, Math.floor((cov + 0.55) * 2.6 + r() * 0.9));
        for (let c = 0; c < clouds; c++) {
          const ox = (cx + r()) * CELL;
          const oz = (cz + r()) * CELL;
          const base = Math.max(this.ground(ox, oz), 0) + BASE_MIN + r() * BASE_RANGE;
          const size = 110 + r() * 230;
          const puffs = 6 + Math.floor(r() * 9);
          const stretch = 1 + r() * 0.8;
          const ang = r() * Math.PI;
          for (let k = 0; k < puffs && n < MAX; k++) {
            const a = r() * Math.PI * 2;
            const d = Math.sqrt(r()) * size;
            let lx = Math.cos(a) * d * stretch;
            const lz = Math.sin(a) * d;
            const rx = lx * Math.cos(ang) - lz * Math.sin(ang);
            const rz = lx * Math.sin(ang) + lz * Math.cos(ang);
            lx = rx;
            const falloff = 1 - (d / size) * 0.55;
            const rad = size * (0.32 + r() * 0.22) * falloff;
            let y = base + rad * 0.45 + r() * size * 0.25 * falloff;
            // on hillsides keep every puff's underside at least 120 m above the ground below it
            y = Math.max(y, Math.max(this.ground(ox + lx, oz + rz), 0) + 120 + rad * 0.85);
            this.spheres[n * 4] = ox + lx;
            this.spheres[n * 4 + 1] = y;
            this.spheres[n * 4 + 2] = oz + rz;
            this.spheres[n * 4 + 3] = rad;
            p.set(ox + lx, y, oz + rz);
            q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r() * 6.28);
            s.set(rad, rad * (0.78 + r() * 0.15), rad);
            m.compose(p, q, s);
            this.mesh.setMatrixAt(n, m);
            n++;
          }
        }
      }
    this.count = n;
    this.mesh.count = n;
    this.outline.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(cam: THREE.Vector3, dt: number, wind: THREE.Vector3) {
    this.drift.addScaledVector(wind, dt * 1.5);
    this.group.position.set(this.drift.x, 0, this.drift.z);
    const lx = cam.x - this.drift.x;
    const lz = cam.z - this.drift.z;
    const ccx = Math.floor(lx / CELL);
    const ccz = Math.floor(lz / CELL);
    if (ccx !== this.lastCell.x || ccz !== this.lastCell.z) {
      this.lastCell = { x: ccx, z: ccz };
      this.build(ccx, ccz);
    }
  }

  /** 0 outside, → 1 deep inside a cloud. */
  densityAt(pos: THREE.Vector3): number {
    const x = pos.x - this.drift.x;
    const y = pos.y;
    const z = pos.z - this.drift.z;
    let best = 0;
    const sp = this.spheres;
    for (let i = 0; i < this.count; i++) {
      const dy = (y - sp[i * 4 + 1]) / 0.85;
      const r = sp[i * 4 + 3];
      if (Math.abs(dy) > r) continue;
      const dx = x - sp[i * 4];
      const dz = z - sp[i * 4 + 2];
      const d2 = (dx * dx + dy * dy + dz * dz) / (r * r);
      if (d2 < 1) best = Math.max(best, 1 - Math.sqrt(d2));
    }
    return best;
  }

  setVisibleRadius(cells: number) {
    this.radiusCells = cells;
    this.lastCell = { x: 1e9, z: 1e9 };
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    (this.outline.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
