import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Helpers to build low-poly, vertex-coloured, outline-ready geometry. */
const tmpColor = new THREE.Color();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();

export interface PartOpts {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
  flat?: boolean;
}

export function part(geom: THREE.BufferGeometry, hex: number, o: PartOpts = {}): THREE.BufferGeometry {
  const g = geom.index ? geom.toNonIndexed() : geom;
  if (g !== geom) geom.dispose();
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  if (o.flat) g.computeVertexNormals();
  tmpP.set(...(o.pos ?? [0, 0, 0]));
  tmpE.set(...(o.rot ?? [0, 0, 0]));
  tmpQ.setFromEuler(tmpE);
  tmpS.set(...(o.scale ?? [1, 1, 1]));
  tmpM.compose(tmpP, tmpQ, tmpS);
  g.applyMatrix4(tmpM);
  const count = g.getAttribute('position').count;
  const cols = new Float32Array(count * 3);
  tmpColor.setHex(hex);
  for (let i = 0; i < count; i++) {
    cols[i * 3] = tmpColor.r;
    cols[i * 3 + 1] = tmpColor.g;
    cols[i * 3 + 2] = tmpColor.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return g;
}

/** Averages normals of coincident vertices so hull outlines have no cracks. */
export function addOutlineNormals(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const acc = new Map<string, [number, number, number]>();
  const keyOf = (i: number) => `${Math.round(pos.getX(i) * 200)},${Math.round(pos.getY(i) * 200)},${Math.round(pos.getZ(i) * 200)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(i);
    const a = acc.get(k) ?? [0, 0, 0];
    a[0] += nor.getX(i);
    a[1] += nor.getY(i);
    a[2] += nor.getZ(i);
    acc.set(k, a);
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const a = acc.get(keyOf(i))!;
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    out[i * 3] = a[0] / l;
    out[i * 3 + 1] = a[1] / l;
    out[i * 3 + 2] = a[2] / l;
  }
  g.setAttribute('outlineNormal', new THREE.BufferAttribute(out, 3));
}

export function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('mergeParts: incompatible geometry attributes');
  for (const p of parts) p.dispose();
  addOutlineNormals(g);
  g.computeBoundingSphere();
  return g;
}

/** Box spanning z ∈ [0, len], tapering to (w2, h2) at the back, shifted by yShift. */
export function taperBox(w: number, h: number, len: number, w2: number, h2: number, yShift: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, len);
  g.translate(0, 0, len / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    if (p.getZ(i) > len / 2) {
      p.setX(i, (p.getX(i) * w2) / w);
      p.setY(i, (p.getY(i) * h2) / h + yShift);
    }
  }
  g.computeVertexNormals();
  return g;
}

/** A mesh plus its hull outline (child, shares geometry & transform). */
export function toonMesh(geom: THREE.BufferGeometry, mat: THREE.Material, outline: THREE.Material | null): THREE.Mesh {
  const m = new THREE.Mesh(geom, mat);
  m.castShadow = true;
  if (outline) {
    const o = new THREE.Mesh(geom, outline);
    o.castShadow = false;
    o.receiveShadow = false;
    o.name = 'outline';
    m.add(o);
  }
  return m;
}
