import * as THREE from 'three';
import { outlineMaterial } from '../render/outline';
import { toonMaterial } from '../render/toon';
import { AirfieldVisual } from './airfieldProps';
import { ChunkManager } from './chunks';
import { Clouds, type CloudCover } from './clouds';
import { PropManager } from './props';
import { hash32, mulberry32 } from './rng';
import { GROUND_CELL, TerrainGen } from './terrain';
import { TIMES, type TimeOfDay } from '../render/sky';

/**
 * The procedural world (design §4) for one seed: terrain chunks, props,
 * airfields, clouds, wind & time of day.
 */
export class World {
  readonly gen: TerrainGen;
  readonly group = new THREE.Group();
  readonly chunks: ChunkManager;
  readonly props: PropManager;
  readonly clouds: Clouds;
  readonly fields: AirfieldVisual[] = [];
  readonly time: TimeOfDay;
  readonly cover: CloudCover;
  readonly wind = new THREE.Vector3();
  /** steady wind (gusts scale it in `wind`); the route planner uses it so plans do not flicker */
  readonly baseWind = new THREE.Vector3();
  private t = 0;
  private hCache = new Map<number, number>();
  private terrainMat: THREE.MeshToonMaterial;
  private propMat: THREE.MeshToonMaterial;
  private propOutline: THREE.ShaderMaterial;
  private stripMat: THREE.MeshToonMaterial;
  private markMat: THREE.MeshToonMaterial;

  constructor(readonly seed: number, radius: number) {
    this.gen = new TerrainGen(seed);
    const r = mulberry32(hash32(seed, 2024));
    this.time = TIMES[Math.floor(r() * TIMES.length)];
    const c = r();
    this.cover = c < 0.2 ? 'clear' : c < 0.8 ? 'fair' : 'overcast';
    const wAng = r() * Math.PI * 2;
    const wSpd = 1.5 + r() * 3.5;
    this.baseWind.set(Math.cos(wAng) * wSpd, 0, Math.sin(wAng) * wSpd);
    this.wind.copy(this.baseWind);

    this.terrainMat = toonMaterial({ vertexColors: true, rim: 0.0, ramp: [128, 198, 255] });
    this.propMat = toonMaterial({ vertexColors: true, rim: 0.2 });
    this.propOutline = outlineMaterial(this.time.ink, 1, 300);
    this.stripMat = toonMaterial({ vertexColors: true, rim: 0 });
    this.stripMat.polygonOffset = true;
    this.stripMat.polygonOffsetFactor = -2;
    this.stripMat.polygonOffsetUnits = -4;
    // runway paint sits on the asphalt: pull it further toward the camera than the strip
    this.markMat = toonMaterial({ vertexColors: true, rim: 0 });
    this.markMat.polygonOffset = true;
    this.markMat.polygonOffsetFactor = -4;
    this.markMat.polygonOffsetUnits = -16;

    this.chunks = new ChunkManager(seed, this.terrainMat, radius);
    this.props = new PropManager(this.propMat, this.propOutline);
    this.clouds = new Clouds(seed, this.cover, (x, z) => this.gen.height(x, z));
    this.group.add(this.chunks.group, this.props.group, this.clouds.group);

    for (const af of this.gen.airfields) {
      const v = new AirfieldVisual(af, this.propMat, this.propOutline, this.stripMat, this.markMat);
      v.setWind(this.wind);
      this.fields.push(v);
      this.group.add(v.group);
    }
  }

  get home() {
    return this.gen.airfields[0];
  }

  /** Analytic terrain height (exact at grid vertices). */
  height(x: number, z: number) {
    return this.gen.height(x, z);
  }

  private gridH(gx: number, gz: number): number {
    const key = (gx + 40000) * 80000 + (gz + 40000);
    let h = this.hCache.get(key);
    if (h === undefined) {
      h = this.gen.height(gx * GROUND_CELL, gz * GROUND_CELL);
      if (this.hCache.size > 60000) this.hCache.clear();
      this.hCache.set(key, h);
    }
    return h;
  }

  /** Ground height matching the finest terrain mesh (same triangles). */
  groundHeight(x: number, z: number): number {
    const c = GROUND_CELL;
    const fxw = x / c;
    const fzw = z / c;
    const gx = Math.floor(fxw);
    const gz = Math.floor(fzw);
    const fx = fxw - gx;
    const fz = fzw - gz;
    const h00 = this.gridH(gx, gz);
    const h10 = this.gridH(gx + 1, gz);
    const h01 = this.gridH(gx, gz + 1);
    const h11 = this.gridH(gx + 1, gz + 1);
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** What the wheels roll on (asphalt, grass, rough ground, water). */
  surfaceAt(x: number, z: number) {
    return this.gen.surfaceAt(x, z);
  }

  /** Approach lights react to where the player is. */
  updatePapi(pos: THREE.Vector3) {
    for (const f of this.fields) f.updatePapi(pos);
  }

  /** Surface the plane can touch: terrain or the sea surface. */
  surfaceHeight(x: number, z: number) {
    return Math.max(this.groundHeight(x, z), 0);
  }

  update(cam: THREE.Vector3, vel: THREE.Vector3 | null, dt: number) {
    this.t += dt;
    const g = 1 + 0.25 * Math.sin(this.t * 0.31) + 0.12 * Math.sin(this.t * 1.13 + 1.7);
    this.wind.copy(this.baseWind).multiplyScalar(g);
    this.chunks.update(cam, vel);
    this.props.update(this.chunks);
    this.clouds.update(cam, dt, this.wind);
    for (const f of this.fields) f.setWind(this.wind);
  }

  setRadius(r: number) {
    this.chunks.radius = r;
    this.clouds.setVisibleRadius(Math.max(3, Math.round((r * 512) / 1600) + 1));
  }

  materials(): THREE.Material[] {
    return [this.terrainMat, this.propMat, this.stripMat, this.markMat];
  }

  dispose() {
    this.chunks.dispose();
    this.props.dispose();
    this.clouds.dispose();
    for (const f of this.fields) f.dispose();
    this.terrainMat.dispose();
    this.propMat.dispose();
    this.propOutline.dispose();
    this.stripMat.dispose();
    this.markMat.dispose();
  }
}
