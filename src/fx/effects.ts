import * as THREE from 'three';
import { addOutlineNormals } from '../render/geo';
import { outlineMaterial } from '../render/outline';
import { toonMaterial } from '../render/toon';

/**
 * Effects (design §5): GPU-instanced cartoon particles — toon-shaded smoke
 * puffs that grow and shrink away (no transparency), fire, dust, hit sparks,
 * muzzle flashes, and "POW!" bursts for explosions.
 */
const MAX_PUFFS = 1800;
const MAX_SPARKS = 500;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

class Pool {
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  life: Float32Array;
  max: Float32Array;
  s0: Float32Array;
  s1: Float32Array;
  drag: Float32Array;
  rise: Float32Array;
  rot: Float32Array;
  col: Float32Array;
  n = 0;
  constructor(readonly cap: number) {
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.rise = new Float32Array(cap);
    this.rot = new Float32Array(cap);
    this.col = new Float32Array(cap * 3);
  }
  add(p: THREE.Vector3, v: THREE.Vector3, life: number, s0: number, s1: number, color: number, drag = 1.2, rise = 0) {
    let i: number;
    if (this.n < this.cap) i = this.n++;
    else i = Math.floor(Math.random() * this.cap);
    this.px[i] = p.x;
    this.py[i] = p.y;
    this.pz[i] = p.z;
    this.vx[i] = v.x;
    this.vy[i] = v.y;
    this.vz[i] = v.z;
    this.life[i] = life;
    this.max[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.drag[i] = drag;
    this.rise[i] = rise;
    this.rot[i] = Math.random() * 6.28;
    _c.setHex(color);
    this.col[i * 3] = _c.r;
    this.col[i * 3 + 1] = _c.g;
    this.col[i * 3 + 2] = _c.b;
  }
  remove(i: number) {
    const j = --this.n;
    this.px[i] = this.px[j];
    this.py[i] = this.py[j];
    this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
    this.life[i] = this.life[j];
    this.max[i] = this.max[j];
    this.s0[i] = this.s0[j];
    this.s1[i] = this.s1[j];
    this.drag[i] = this.drag[j];
    this.rise[i] = this.rise[j];
    this.rot[i] = this.rot[j];
    this.col[i * 3] = this.col[j * 3];
    this.col[i * 3 + 1] = this.col[j * 3 + 1];
    this.col[i * 3 + 2] = this.col[j * 3 + 2];
  }
  step(dt: number) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.remove(i);
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k;
      this.vy[i] = this.vy[i] * k + this.rise[i] * dt;
      this.vz[i] *= k;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
    }
  }
}

function makePow(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.translate(128, 128);
  g.beginPath();
  for (let i = 0; i < 24; i++) {
    const r = i % 2 ? 70 : 122;
    const a = (i / 24) * Math.PI * 2;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = '#ffd23f';
  g.fill();
  g.lineWidth = 10;
  g.strokeStyle = '#2b1d1a';
  g.stroke();
  g.rotate(-0.15);
  g.font = '900 72px "Luckiest Guy", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 12;
  g.strokeStyle = '#2b1d1a';
  g.strokeText('POW!', 0, 6);
  g.fillStyle = '#e04f3a';
  g.fillText('POW!', 0, 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  readonly group = new THREE.Group();
  private puffs = new Pool(MAX_PUFFS);
  private sparks = new Pool(MAX_SPARKS);
  private puffMesh: THREE.InstancedMesh;
  private puffOutline: THREE.InstancedMesh;
  private sparkMesh: THREE.InstancedMesh;
  private pows: { sprite: THREE.Sprite; t: number }[] = [];
  private tmpV = new THREE.Vector3();

  constructor() {
    const g = new THREE.IcosahedronGeometry(1, 0);
    addOutlineNormals(g);
    this.puffMesh = new THREE.InstancedMesh(g, toonMaterial({ color: 0xffffff, rim: 0.1 }), MAX_PUFFS);
    this.puffMesh.count = 0;
    this.puffMesh.frustumCulled = false;
    this.puffMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.puffOutline = new THREE.InstancedMesh(g, outlineMaterial(0x2b1d1a, 0.8, 250), MAX_PUFFS);
    this.puffOutline.instanceMatrix = this.puffMesh.instanceMatrix;
    this.puffOutline.count = 0;
    this.puffOutline.frustumCulled = false;
    this.sparkMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_SPARKS);
    this.sparkMesh.count = 0;
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.group.add(this.puffMesh, this.puffOutline, this.sparkMesh);

    const tex = makePow();
    for (let i = 0; i < 6; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
      sprite.visible = false;
      this.group.add(sprite);
      this.pows.push({ sprite, t: 99 });
    }
    this.group.name = 'fx';
  }

  clear() {
    this.puffs.n = 0;
    this.sparks.n = 0;
    for (const p of this.pows) {
      p.t = 99;
      p.sprite.visible = false;
    }
  }

  private rv(scale: number) {
    return this.tmpV.set((Math.random() - 0.5) * scale, (Math.random() - 0.5) * scale, (Math.random() - 0.5) * scale);
  }

  smoke(pos: THREE.Vector3, vel: THREE.Vector3, dark: number) {
    const v = this.rv(3).addScaledVector(vel, 0.15);
    const col = dark > 0.6 ? 0x3b3633 : dark > 0.3 ? 0x77706a : 0xc9c4bc;
    this.puffs.add(pos, v, 2.4 + Math.random(), 0.9, 4.5 + dark * 3, col, 0.8, 2.5);
  }

  fire(pos: THREE.Vector3, vel: THREE.Vector3) {
    const v = this.rv(4).addScaledVector(vel, 0.3);
    this.puffs.add(pos, v, 0.45, 1.6, 0.4, Math.random() < 0.5 ? 0xffb02e : 0xff6a2a, 2, 2);
  }

  dust(pos: THREE.Vector3, color = 0xd8c49a) {
    const v = this.rv(4);
    v.y = Math.abs(v.y) + 1;
    this.puffs.add(pos, v, 1.0, 0.6, 1.7, color, 1.5, 0.5);
  }

  splash(pos: THREE.Vector3) {
    for (let i = 0; i < 26; i++) {
      const v = this.rv(14);
      v.y = 6 + Math.random() * 14;
      this.puffs.add(pos, v, 1.6, 2, 0.6, i % 3 ? 0xf4fbff : 0x9fdcef, 0.6, -14);
    }
  }

  groundHit(pos: THREE.Vector3) {
    const v = this.rv(2);
    v.y = 3 + Math.random() * 3;
    this.puffs.add(pos, v, 0.7, 0.6, 1.8, 0xc9b28a, 2, -4);
  }

  sparksAt(pos: THREE.Vector3, n = 6) {
    for (let i = 0; i < n; i++) this.sparks.add(pos, this.rv(30), 0.25 + Math.random() * 0.2, 0.35, 0.05, Math.random() < 0.5 ? 0xffe066 : 0xffffff, 3, -10);
  }

  muzzle(pos: THREE.Vector3, vel: THREE.Vector3) {
    this.sparks.add(pos, vel, 0.05, 0.45, 0.2, 0xfff2a0, 0, 0);
  }

  debris(pos: THREE.Vector3, vel: THREE.Vector3, color: number) {
    const v = this.rv(16).addScaledVector(vel, 0.6);
    v.y += 5;
    this.puffs.add(pos, v, 1.8, 0.45, 0.35, color, 0.2, -9.8);
  }

  explosion(pos: THREE.Vector3, big = true) {
    const n = big ? 30 : 14;
    for (let i = 0; i < n; i++) {
      const v = this.rv(big ? 26 : 14);
      this.puffs.add(pos, v, 0.6 + Math.random() * 0.4, 2.5 + Math.random() * 2, 0.5, i % 3 === 0 ? 0xffe066 : 0xff8a2a, 2.5, 3);
    }
    for (let i = 0; i < n; i++) {
      const v = this.rv(big ? 14 : 8);
      v.y = Math.abs(v.y);
      this.puffs.add(pos, v, 2.5 + Math.random() * 1.5, 2, 8, 0x3b3633, 1, 4);
    }
    this.sparksAt(pos, 24);
    if (big) {
      const p = this.pows.reduce((a, b) => (a.t > b.t ? a : b));
      p.t = 0;
      p.sprite.position.copy(pos).y += 6;
      p.sprite.visible = true;
    }
  }

  update(dt: number, cam: THREE.Vector3) {
    this.puffs.step(dt);
    this.sparks.step(dt);
    this.write(this.puffs, this.puffMesh, cam);
    this.puffOutline.count = this.puffMesh.count;
    this.write(this.sparks, this.sparkMesh, cam);
    for (const p of this.pows) {
      if (!p.sprite.visible) continue;
      p.t += dt;
      const grow = Math.min(p.t / 0.12, 1);
      p.sprite.scale.setScalar(26 * grow + p.t * 6);
      (p.sprite.material as THREE.SpriteMaterial).opacity = 1 - THREE.MathUtils.smoothstep(p.t, 0.5, 0.9);
      if (p.t > 0.9) p.sprite.visible = false;
    }
  }

  private write(pool: Pool, mesh: THREE.InstancedMesh, cam: THREE.Vector3) {
    for (let i = 0; i < pool.n; i++) {
      const t = 1 - pool.life[i] / pool.max[i];
      // grow quickly, then shrink away at the end
      const grow = pool.s0[i] + (pool.s1[i] - pool.s0[i]) * Math.sqrt(t);
      let size = grow * (t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1);
      _p.set(pool.px[i], pool.py[i], pool.pz[i]);
      // never let a puff swallow the camera (its ink hull would fill the screen)
      const d = _p.distanceTo(cam);
      if (d < size * 2.5 + 1) size *= THREE.MathUtils.clamp((d - 1) / (size * 2.5), 0, 1);
      _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, pool.rot[i]);
      _s.setScalar(Math.max(size, 0.001));
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      _c.setRGB(pool.col[i * 3], pool.col[i * 3 + 1], pool.col[i * 3 + 2]);
      mesh.setColorAt(i, _c);
    }
    mesh.count = pool.n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
