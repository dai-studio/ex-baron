import * as THREE from 'three';
import type { ChunkData, ChunkRequest } from './chunkBuild';
import { CHUNK_SIZE } from './terrain';

/**
 * Chunk streaming & LOD (design §4): concentric LOD rings around the camera,
 * meshes built in a Worker pool, uploads spread over frames under a budget,
 * prefetch along the velocity vector.
 */
interface Entry {
  cx: number;
  cz: number;
  res: number; // currently displayed resolution (0 = nothing yet)
  props: boolean;
  wantRes: number;
  wantProps: boolean;
  pendingId: number; // 0 = none
  pendingRes: number;
  pendingProps: boolean;
  mesh: THREE.Mesh | null;
  propData: Float32Array | null;
}

export function lodFor(d: number): { res: number; props: boolean } {
  if (d <= 1) return { res: 64, props: true };
  if (d <= 2) return { res: 32, props: true };
  if (d <= 4) return { res: 16, props: false };
  return { res: 8, props: false };
}

export class ChunkManager {
  readonly group = new THREE.Group();
  private entries = new Map<string, Entry>();
  private workers: Worker[] = [];
  private idle: boolean[] = [];
  private pending = new Map<number, Entry>();
  private ready: ChunkData[] = [];
  private nextId = 1;
  propsVersion = 0;
  private disposed = false;

  constructor(
    readonly seed: number,
    private material: THREE.Material,
    public radius: number,
  ) {
    this.group.name = 'terrain';
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<ChunkData>) => {
        this.idle[i] = true;
        if (this.disposed) return;
        const entry = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        if (entry && entry.pendingId === e.data.id) this.ready.push(e.data);
      };
      this.workers.push(w);
      this.idle.push(true);
    }
  }

  private key(cx: number, cz: number) {
    return `${cx},${cz}`;
  }

  update(cam: THREE.Vector3, vel: THREE.Vector3 | null, budgetMs = 2.5) {
    const size = CHUNK_SIZE;
    const R = this.radius;
    const ccx = Math.floor(cam.x / size);
    const ccz = Math.floor(cam.z / size);
    const lead = vel ? 3 : 0;
    const px = (cam.x + (vel ? vel.x * lead : 0)) / size;
    const pz = (cam.z + (vel ? vel.z * lead : 0)) / size;

    // desired set
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > (R + 0.5) * (R + 0.5)) continue;
        const cx = ccx + dx;
        const cz = ccz + dz;
        const d = Math.max(Math.abs(dx), Math.abs(dz));
        const lod = lodFor(d);
        const k = this.key(cx, cz);
        let e = this.entries.get(k);
        if (!e) {
          e = { cx, cz, res: 0, props: false, wantRes: 0, wantProps: false, pendingId: 0, pendingRes: 0, pendingProps: false, mesh: null, propData: null };
          this.entries.set(k, e);
        }
        e.wantRes = lod.res;
        e.wantProps = lod.props;
      }

    // evict far chunks
    for (const [k, e] of this.entries) {
      const dx = e.cx - ccx;
      const dz = e.cz - ccz;
      if (dx * dx + dz * dz > (R + 1.5) * (R + 1.5)) {
        this.removeEntry(e);
        this.entries.delete(k);
      }
    }

    // dispatch work, nearest to the prefetch point first
    const freeWorkers = this.idle.filter((x) => x).length;
    if (freeWorkers > 0) {
      const need: { e: Entry; pri: number }[] = [];
      for (const e of this.entries.values()) {
        const ok = e.res === e.wantRes && e.props === e.wantProps;
        const inFlight = e.pendingId !== 0 && e.pendingRes === e.wantRes && e.pendingProps === e.wantProps;
        if (ok || inFlight) continue;
        const ddx = e.cx + 0.5 - px;
        const ddz = e.cz + 0.5 - pz;
        // missing chunks first, then upgrades
        need.push({ e, pri: ddx * ddx + ddz * ddz + (e.res === 0 ? 0 : 6) });
      }
      need.sort((a, b) => a.pri - b.pri);
      let ni = 0;
      for (let w = 0; w < this.workers.length && ni < need.length; w++) {
        if (!this.idle[w]) continue;
        const e = need[ni++].e;
        const id = this.nextId++;
        e.pendingId = id;
        e.pendingRes = e.wantRes;
        e.pendingProps = e.wantProps;
        this.pending.set(id, e);
        this.idle[w] = false;
        const req: ChunkRequest = { id, seed: this.seed, cx: e.cx, cz: e.cz, res: e.wantRes, props: e.wantProps };
        this.workers[w].postMessage(req);
      }
    }

    // upload finished chunks within the frame budget
    const t0 = performance.now();
    while (this.ready.length && performance.now() - t0 < budgetMs) {
      const d = this.ready.shift()!;
      const e = this.entries.get(this.key(d.cx, d.cz));
      if (!e || e.pendingId !== d.id) continue;
      this.applyChunk(e, d);
    }
  }

  private applyChunk(e: Entry, d: ChunkData) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(d.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(d.indices, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(d.cx * CHUNK_SIZE, 0, d.cz * CHUNK_SIZE);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (e.mesh) {
      this.group.remove(e.mesh);
      e.mesh.geometry.dispose();
    }
    this.group.add(mesh);
    e.mesh = mesh;
    e.res = d.res;
    e.pendingId = 0;
    const hadProps = e.props;
    e.props = d.hasProps;
    if (d.hasProps) {
      e.propData = d.props;
      this.propsVersion++;
    } else if (hadProps) {
      e.propData = null;
      this.propsVersion++;
    }
  }

  private removeEntry(e: Entry) {
    if (e.pendingId) this.pending.delete(e.pendingId);
    e.pendingId = 0;
    if (e.mesh) {
      this.group.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh = null;
    }
    if (e.propData) this.propsVersion++;
    e.propData = null;
  }

  /** Visit every loaded chunk's prop list. */
  forEachProps(cb: (cx: number, cz: number, data: Float32Array) => void) {
    for (const e of this.entries.values()) if (e.propData && e.propData.length) cb(e.cx, e.cz, e.propData);
  }

  /** Fraction (0..1) of chunks within `rings` of pos that are at their wanted LOD. */
  readiness(pos: THREE.Vector3, rings: number): number {
    const ccx = Math.floor(pos.x / CHUNK_SIZE);
    const ccz = Math.floor(pos.z / CHUNK_SIZE);
    let total = 0;
    let ok = 0;
    for (let dz = -rings; dz <= rings; dz++)
      for (let dx = -rings; dx <= rings; dx++) {
        total++;
        const e = this.entries.get(this.key(ccx + dx, ccz + dz));
        if (e && e.res !== 0 && e.res === e.wantRes && e.props === e.wantProps) ok++;
      }
    return ok / total;
  }

  get chunkCount() {
    return this.group.children.length;
  }

  dispose() {
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    for (const e of this.entries.values()) this.removeEntry(e);
    this.entries.clear();
  }
}
