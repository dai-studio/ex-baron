import * as THREE from 'three';
import { MUZZLES, type Plane } from '../plane/plane';

/**
 * Weapons & damage (design §3): twin synchronised machine guns firing fast
 * ray-cast projectiles stepped each tick, a tracer every 4th round, gun heat
 * and limited ammo. Hits are resolved against per-zone boxes in plane space.
 */
export type Zone = 'engine' | 'wings' | 'tail' | 'pilot' | 'fuselage';

interface Box {
  zone: Zone;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

const BOXES: Box[] = [
  { zone: 'engine', min: new THREE.Vector3(-0.66, -0.6, -3.0), max: new THREE.Vector3(0.66, 0.7, -1.6) },
  { zone: 'pilot', min: new THREE.Vector3(-0.35, 0.3, -0.5), max: new THREE.Vector3(0.35, 1.15, 0.45) },
  { zone: 'fuselage', min: new THREE.Vector3(-0.55, -0.55, -1.6), max: new THREE.Vector3(0.55, 0.65, 2.8) },
  { zone: 'tail', min: new THREE.Vector3(-1.6, -0.1, 2.8), max: new THREE.Vector3(1.6, 1.4, 4.45) },
  { zone: 'wings', min: new THREE.Vector3(-4.35, 1.38, -1.8), max: new THREE.Vector3(4.35, 1.62, -0.0) },
  { zone: 'wings', min: new THREE.Vector3(-4.05, -0.56, -1.3), max: new THREE.Vector3(4.05, -0.34, 0.2) },
];

export const BULLET_SPEED = 780;
const MAX = 900;
const LIFE = 1.6;
const HEAT_PER_SHOT = 0.011;
const COOL_RATE = 0.28;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _fwd = new THREE.Vector3();

/** Segment vs AABB (slab method) in local space; returns entry t or -1. */
function segBox(a: THREE.Vector3, d: THREE.Vector3, b: Box): number {
  let tmin = 0;
  let tmax = 1;
  for (const ax of ['x', 'y', 'z'] as const) {
    const o = a[ax];
    const dd = d[ax];
    const lo = b.min[ax];
    const hi = b.max[ax];
    if (Math.abs(dd) < 1e-9) {
      if (o < lo || o > hi) return -1;
    } else {
      let t1 = (lo - o) / dd;
      let t2 = (hi - o) / dd;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

export interface HitInfo {
  shooter: Plane;
  target: Plane;
  zone: Zone;
  point: THREE.Vector3;
}

export class Bullets {
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX);
  private pz = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private vz = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private tracer = new Uint8Array(MAX);
  private owner: (Plane | null)[] = new Array(MAX).fill(null);
  private n = 0;
  readonly mesh: THREE.InstancedMesh;

  constructor() {
    const g = new THREE.BoxGeometry(0.22, 0.22, 1);
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xfff1a8 }), MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'tracers';
  }

  clear() {
    this.n = 0;
    this.mesh.count = 0;
  }

  /** Try to fire this tick; returns muzzle world positions fired from (0..1). */
  updateGuns(p: Plane, dt: number, onFire: (muzzle: THREE.Vector3, p: Plane) => void) {
    const s = p.s;
    s.gunHeat = Math.max(0, s.gunHeat - COOL_RATE * dt);
    if (s.overheated && s.gunHeat < 0.35) s.overheated = false;
    p.gunCooldown -= dt;
    if (!p.input.fire || s.overheated || s.ammo <= 0 || !p.alive) return;
    if (p.gunCooldown > 0) return;
    p.gunCooldown += 1 / 15;
    if (p.gunCooldown < 0) p.gunCooldown = 0;
    p.gunSide ^= 1;
    s.ammo--;
    s.gunHeat += HEAT_PER_SHOT;
    if (s.gunHeat >= 1) s.overheated = true;
    p.shots++;
    const muzzle = _a.copy(MUZZLES[p.gunSide]).applyQuaternion(s.quat).add(s.pos);
    p.forward(_fwd);
    // slight convergence and spread
    _d.copy(_fwd);
    _d.x += (Math.random() - 0.5) * 0.006;
    _d.y += (Math.random() - 0.5) * 0.006;
    _d.z += (Math.random() - 0.5) * 0.006;
    _d.normalize();
    this.spawn(muzzle, _d, s.vel, p, p.shots % 4 === 0);
    onFire(muzzle, p);
  }

  private spawn(pos: THREE.Vector3, dir: THREE.Vector3, baseVel: THREE.Vector3, owner: Plane, tracer: boolean) {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.px[i] = pos.x;
    this.py[i] = pos.y;
    this.pz[i] = pos.z;
    this.vx[i] = baseVel.x + dir.x * BULLET_SPEED;
    this.vy[i] = baseVel.y + dir.y * BULLET_SPEED;
    this.vz[i] = baseVel.z + dir.z * BULLET_SPEED;
    this.life[i] = LIFE;
    this.tracer[i] = tracer ? 1 : 0;
    this.owner[i] = owner;
  }

  private kill(i: number) {
    const j = --this.n;
    this.px[i] = this.px[j];
    this.py[i] = this.py[j];
    this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
    this.life[i] = this.life[j];
    this.tracer[i] = this.tracer[j];
    this.owner[i] = this.owner[j];
    this.owner[j] = null;
  }

  step(
    dt: number,
    planes: Plane[],
    ground: (x: number, z: number) => number,
    onHit: (h: HitInfo) => void,
    onGround: (p: THREE.Vector3) => void,
    tick: number,
  ) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      _a.set(this.px[i], this.py[i], this.pz[i]);
      this.vy[i] -= 9.81 * 0.5 * dt;
      _d.set(this.vx[i] * dt, this.vy[i] * dt, this.vz[i] * dt);
      _b.copy(_a).add(_d);
      let hit = false;
      const owner = this.owner[i];
      for (const p of planes) {
        if (p === owner || p.wrecked) continue;
        // segment-sphere broad phase
        const cx = p.s.pos.x - _a.x;
        const cy = p.s.pos.y - _a.y;
        const cz = p.s.pos.z - _a.z;
        const dd = _d.lengthSq();
        let t = (cx * _d.x + cy * _d.y + cz * _d.z) / dd;
        t = Math.max(0, Math.min(1, t));
        const ex = _a.x + _d.x * t - p.s.pos.x;
        const ey = _a.y + _d.y * t - p.s.pos.y;
        const ez = _a.z + _d.z * t - p.s.pos.z;
        if (ex * ex + ey * ey + ez * ez > 5.2 * 5.2) continue;
        // narrow phase in plane space
        _q.copy(p.s.quat).invert();
        const la = _s.copy(_a).sub(p.s.pos).applyQuaternion(_q);
        const ld = new THREE.Vector3().copy(_d).applyQuaternion(_q);
        let best = 2;
        let zone: Zone | null = null;
        for (const box of BOXES) {
          const tt = segBox(la, ld, box);
          if (tt >= 0 && tt < best) {
            best = tt;
            zone = box.zone;
          }
        }
        if (zone && owner) {
          const point = _a.clone().addScaledVector(_d, best);
          onHit({ shooter: owner, target: p, zone, point });
          hit = true;
          break;
        }
      }
      if (hit) {
        this.kill(i);
        continue;
      }
      this.px[i] = _b.x;
      this.py[i] = _b.y;
      this.pz[i] = _b.z;
      // terrain check every 3rd tick per bullet (cheap enough)
      if ((tick + i) % 3 === 0) {
        const g = Math.max(ground(_b.x, _b.z), 0);
        if (_b.y < g) {
          _b.y = g;
          onGround(_b.clone());
          this.kill(i);
        }
      }
    }
  }

  syncVisual() {
    let c = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.tracer[i]) continue;
      _d.set(this.vx[i], this.vy[i], this.vz[i]);
      const sp = _d.length();
      if (sp < 1) continue;
      _d.divideScalar(sp);
      _q.setFromUnitVectors(_z, _d);
      _a.set(this.px[i], this.py[i], this.pz[i]).addScaledVector(_d, -7);
      _s.set(1, 1, 14);
      _m.compose(_a, _q, _s);
      this.mesh.setMatrixAt(c++, _m);
    }
    this.mesh.count = c;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
