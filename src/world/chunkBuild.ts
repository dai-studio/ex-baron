import { CHUNK_SIZE, PROP_BARN, PROP_HOUSE, PROP_PINE, PROP_ROUND, PROP_WINDMILL, TerrainGen } from './terrain';
import { hash32, mulberry32 } from './rng';

/** Pure chunk builder shared by the Web Workers and unit tests (design §4). */
export interface ChunkRequest {
  id: number;
  seed: number;
  cx: number;
  cz: number;
  res: number;
  props: boolean;
}

export interface ChunkData {
  id: number;
  cx: number;
  cz: number;
  res: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** per prop: x, y, z (chunk-local x/z), scale, rotY, type */
  props: Float32Array;
  hasProps: boolean;
}

export const PROP_STRIDE = 6;

export function buildChunk(gen: TerrainGen, req: ChunkRequest): ChunkData {
  const { cx, cz, res } = req;
  const size = CHUNK_SIZE;
  const cell = size / res;
  const x0 = cx * size;
  const z0 = cz * size;
  const n = res + 1;
  const g = res + 3;

  const hs = new Float32Array(g * g);
  for (let j = 0; j < g; j++)
    for (let i = 0; i < g; i++) hs[j * g + i] = gen.height(x0 + (i - 1) * cell, z0 + (j - 1) * cell);

  const loopLen = 4 * res;
  const vCount = n * n + loopLen;
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const colors = new Float32Array(vCount * 3);

  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const v = j * n + i;
      const gi = (j + 1) * g + (i + 1);
      const h = hs[gi];
      const nx = hs[gi - 1] - hs[gi + 1];
      const ny = 2 * cell;
      const nz = hs[gi - g] - hs[gi + g];
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      positions[v * 3] = i * cell;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = j * cell;
      normals[v * 3] = nx * inv;
      normals[v * 3 + 1] = ny * inv;
      normals[v * 3 + 2] = nz * inv;
      gen.colorAt(x0 + i * cell, z0 + j * cell, h, ny * inv, colors, v * 3);
    }

  // border loop (clockwise when seen from above) for skirts that hide LOD cracks
  const loop: number[] = [];
  for (let i = 0; i < res; i++) loop.push(i); // j = 0
  for (let j = 0; j < res; j++) loop.push(j * n + res); // i = res
  for (let i = res; i > 0; i--) loop.push(res * n + i); // j = res
  for (let j = res; j > 0; j--) loop.push(j * n); // i = 0
  const skirt = cell * 1.5 + 12;
  for (let k = 0; k < loopLen; k++) {
    const src = loop[k];
    const dst = n * n + k;
    positions[dst * 3] = positions[src * 3];
    positions[dst * 3 + 1] = positions[src * 3 + 1] - skirt;
    positions[dst * 3 + 2] = positions[src * 3 + 2];
    for (let c = 0; c < 3; c++) {
      normals[dst * 3 + c] = normals[src * 3 + c];
      colors[dst * 3 + c] = colors[src * 3 + c];
    }
  }

  const indices = new Uint32Array(res * res * 6 + loopLen * 12);
  let p = 0;
  for (let j = 0; j < res; j++)
    for (let i = 0; i < res; i++) {
      const a = j * n + i;
      const b = a + n; // z + 1
      const c = a + 1; // x + 1
      const d = b + 1;
      indices[p++] = a;
      indices[p++] = b;
      indices[p++] = c;
      indices[p++] = c;
      indices[p++] = b;
      indices[p++] = d;
    }
  for (let k = 0; k < loopLen; k++) {
    const a = loop[k];
    const b = loop[(k + 1) % loopLen];
    const a2 = n * n + k;
    const b2 = n * n + ((k + 1) % loopLen);
    // both windings so skirts are visible from either side
    indices[p++] = a;
    indices[p++] = b;
    indices[p++] = b2;
    indices[p++] = a;
    indices[p++] = b2;
    indices[p++] = a2;
    indices[p++] = b;
    indices[p++] = a;
    indices[p++] = b2;
    indices[p++] = b2;
    indices[p++] = a;
    indices[p++] = a2;
  }

  const props = req.props ? buildProps(gen, req.seed, cx, cz) : new Float32Array(0);
  return { id: req.id, cx, cz, res, positions, normals, colors, indices, props, hasProps: req.props };
}

function buildProps(gen: TerrainGen, seed: number, cx: number, cz: number): Float32Array {
  const out: number[] = [];
  const size = CHUNK_SIZE;
  const x0 = cx * size;
  const z0 = cz * size;
  const r = mulberry32(hash32(seed, cx, cz, 4242));

  // trees on a jittered grid
  const tc = 22;
  for (let z = 0; z < size; z += tc)
    for (let x = 0; x < size; x += tc) {
      const px = x + r() * tc;
      const pz = z + r() * tc;
      const roll = r();
      const sc = r();
      const rot = r();
      const wx = x0 + px;
      const wz = z0 + pz;
      const h = gen.height(wx, wz);
      if (h < 1.5) continue;
      const field = gen.fieldMask(wx, wz);
      if (field > 0.02) continue;
      const slope = gen.slopeAt(wx, wz);
      const fd = gen.forestDensity(wx, wz, h, slope, field);
      const farm = gen.farmMask(wx, wz, h, slope);
      const prob = fd > 0.45 ? 0.85 * fd : farm > 0.5 ? 0.006 : 0.02;
      if (roll >= prob) continue;
      const type = gen.isPine(wx, wz, h) ? PROP_PINE : PROP_ROUND;
      out.push(px, h - 0.4, pz, 0.75 + sc * 0.7, rot * Math.PI * 2, type);
    }

  // farm buildings
  const hc = 128;
  for (let z = 0; z < size; z += hc)
    for (let x = 0; x < size; x += hc) {
      const px = x + 20 + r() * (hc - 40);
      const pz = z + 20 + r() * (hc - 40);
      const roll = r();
      const kind = r();
      const rot = r();
      const wx = x0 + px;
      const wz = z0 + pz;
      const h = gen.height(wx, wz);
      if (h < 4) continue;
      if (gen.fieldMask(wx, wz) > 0) continue;
      const slope = gen.slopeAt(wx, wz);
      if (slope > 0.1) continue;
      if (gen.farmMask(wx, wz, h, slope) < 0.5) continue;
      if (roll > 0.32) continue;
      const type = kind < 0.08 ? PROP_WINDMILL : kind < 0.4 ? PROP_BARN : PROP_HOUSE;
      out.push(px, h - 0.3, pz, 1, rot * Math.PI * 2, type);
    }
  return new Float32Array(out);
}
