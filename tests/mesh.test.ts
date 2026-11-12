import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PAINTS, STYLES, WHEELS, type Loadout } from '../src/plane/loadout';
import { PlaneVisual } from '../src/plane/planeMesh';

/**
 * Z-fighting guard: two differently coloured faces that lie in the same plane,
 * face the same way and overlap flicker as the plane turns (e.g. a wingtip cap
 * ending flush with the wing). Faces closer than TOL count as the same plane.
 */
const TOL = 0.004;

interface Tri {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  n: THREE.Vector3;
  d: number;
  color: string;
  mesh: number;
}

function collect(v: PlaneVisual): Tri[] {
  const tris: Tri[] = [];
  let meshId = 0;
  v.root.updateMatrixWorld(true);
  v.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.name === 'outline' || !(o.material instanceof THREE.MeshToonMaterial || o.material.type === 'MeshBasicMaterial')) return;
    if (o.material instanceof THREE.MeshBasicMaterial) return; // flames / prop disc are transparent overlays
    const id = meshId++;
    const g = o.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    const col = g.getAttribute('color');
    for (let i = 0; i < pos.count; i += 3) {
      const p = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, i + k).applyMatrix4(o.matrixWorld));
      const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
      if (n.lengthSq() < 1e-10) continue;
      n.normalize();
      const color = col ? `${col.getX(i).toFixed(3)},${col.getY(i).toFixed(3)},${col.getZ(i).toFixed(3)}` : 'none';
      tris.push({ a: p[0], b: p[1], c: p[2], n, d: n.dot(p[0]), color, mesh: id });
    }
  });
  return tris;
}

/** Do two coplanar triangles overlap with real area (2D separating-axis test)? */
function overlap2D(t: Tri, u: Tri): boolean {
  const ax = Math.abs(t.n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const e1 = new THREE.Vector3().crossVectors(t.n, ax).normalize();
  const e2 = new THREE.Vector3().crossVectors(t.n, e1);
  const P = [t.a, t.b, t.c].map((p) => [p.dot(e1), p.dot(e2)]);
  const Q = [u.a, u.b, u.c].map((p) => [p.dot(e1), p.dot(e2)]);
  const eps = 0.002; // ignore faces that only touch along an edge
  for (const poly of [P, Q])
    for (let i = 0; i < 3; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % 3];
      const nx = y2 - y1;
      const ny = x1 - x2;
      const l = Math.hypot(nx, ny);
      if (l < 1e-9) continue;
      const pr = (pts: number[][]) => pts.map(([x, y]) => (x * nx + y * ny) / l);
      const a = pr(P);
      const b = pr(Q);
      if (Math.max(...a) <= Math.min(...b) + eps || Math.max(...b) <= Math.min(...a) + eps) return false;
    }
  return true;
}

function fights(l: Loadout): string[] {
  const mat = new THREE.MeshToonMaterial();
  const v = new PlaneVisual(l, mat, new THREE.MeshBasicMaterial());
  const tris = collect(v);
  const out: string[] = [];
  for (let i = 0; i < tris.length; i++)
    for (let j = i + 1; j < tris.length; j++) {
      const t = tris[i];
      const u = tris[j];
      if (t.color === u.color) continue;
      if (t.n.dot(u.n) < 0.999 || Math.abs(t.d - u.d) > TOL) continue;
      if (overlap2D(t, u)) out.push(`${t.color} vs ${u.color} on plane n=(${t.n.toArray().map((x) => x.toFixed(2))}) d=${t.d.toFixed(3)}`);
    }
  v.dispose();
  return [...new Set(out)];
}

describe('plane meshes have no z-fighting faces', () => {
  // Snow and Sky add a stripe, so they cover the extra parts
  for (const st of STYLES)
    for (const w of WHEELS)
      for (const paint of ['sunflower', 'snow'] as const)
        it(`${st.id} ${w.id} ${paint}`, () => {
          expect(PAINTS.some((p) => p.id === paint)).toBe(true);
          expect(fights({ style: st.id, paint, wheels: w.id })).toEqual([]);
        });
});
