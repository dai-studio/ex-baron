import * as THREE from 'three';
import { mergeParts, part } from '../render/geo';
import { PROP_STRIDE } from './chunkBuild';
import type { ChunkManager } from './chunks';
import { CHUNK_SIZE, PROP_BARN, PROP_HOUSE, PROP_PINE, PROP_ROUND, PROP_WINDMILL } from './terrain';

/**
 * Props (design §4 "Airfields & props"): trees and farm buildings, drawn with
 * one InstancedMesh per type (+ hull outline sharing its matrices) for the
 * whole world, rebuilt only when the set of chunks with props changes.
 */
function pineGeo() {
  return mergeParts([
    part(new THREE.CylinderGeometry(0.35, 0.45, 3, 6), 0x7a4b2a, { pos: [0, 1.5, 0] }),
    part(new THREE.ConeGeometry(3.0, 5, 7), 0x2f7d3a, { pos: [0, 5, 0], flat: true }),
    part(new THREE.ConeGeometry(2.3, 4.2, 7), 0x3a8f42, { pos: [0, 7.6, 0], flat: true }),
    part(new THREE.ConeGeometry(1.5, 3.4, 7), 0x47a04a, { pos: [0, 9.9, 0], flat: true }),
  ]);
}
function roundGeo() {
  return mergeParts([
    part(new THREE.CylinderGeometry(0.4, 0.55, 4, 6), 0x7a4b2a, { pos: [0, 2, 0] }),
    part(new THREE.IcosahedronGeometry(3.4, 0), 0x5fb043, { pos: [0, 6.2, 0], flat: true }),
    part(new THREE.IcosahedronGeometry(2.2, 0), 0x6fc04c, { pos: [1.4, 8.0, 0.6], flat: true }),
  ]);
}
function houseGeo() {
  return mergeParts([
    part(new THREE.BoxGeometry(9, 5, 7), 0xfff0cf, { pos: [0, 2.5, 0] }),
    part(new THREE.CylinderGeometry(4.6, 4.6, 9.6, 3, 1), 0xd2553d, { pos: [0, 6.2, 0], rot: [0, 0, Math.PI / 2], scale: [1, 1, 0.9], flat: true }),
    part(new THREE.BoxGeometry(1.4, 2.6, 0.2), 0x6b3f22, { pos: [0, 1.3, 3.55] }),
    part(new THREE.BoxGeometry(1.4, 1.2, 0.2), 0x7ec8e3, { pos: [-2.7, 2.8, 3.55] }),
    part(new THREE.BoxGeometry(1.4, 1.2, 0.2), 0x7ec8e3, { pos: [2.7, 2.8, 3.55] }),
    part(new THREE.BoxGeometry(1.0, 2.4, 1.0), 0x9a5a44, { pos: [2.6, 7.4, -1.2] }),
  ]);
}
function barnGeo() {
  return mergeParts([
    part(new THREE.BoxGeometry(13, 7, 9), 0xc63e2e, { pos: [0, 3.5, 0] }),
    part(new THREE.CylinderGeometry(6, 6, 13.6, 3, 1), 0x5b4236, { pos: [0, 8.2, 0], rot: [0, 0, Math.PI / 2], scale: [1, 1, 0.82], flat: true }),
    part(new THREE.BoxGeometry(4, 5, 0.2), 0xfff0cf, { pos: [0, 2.5, 4.55] }),
  ]);
}
function windmillGeo() {
  return mergeParts([
    part(new THREE.CylinderGeometry(2.2, 3.6, 14, 8), 0xfff0cf, { pos: [0, 7, 0], flat: true }),
    part(new THREE.ConeGeometry(3.0, 4, 8), 0x7a4b2a, { pos: [0, 16, 0], flat: true }),
    part(new THREE.BoxGeometry(0.8, 16, 0.3), 0x8a5a3a, { pos: [0, 13, 3.3], rot: [0, 0, 0.4] }),
    part(new THREE.BoxGeometry(16, 0.8, 0.3), 0x8a5a3a, { pos: [0, 13, 3.3], rot: [0, 0, 0.4] }),
  ]);
}

const CAPS: Record<number, number> = {
  [PROP_PINE]: 30000,
  [PROP_ROUND]: 30000,
  [PROP_HOUSE]: 3000,
  [PROP_BARN]: 2000,
  [PROP_WINDMILL]: 600,
};

export class PropManager {
  readonly group = new THREE.Group();
  private meshes = new Map<number, { mesh: THREE.InstancedMesh; outline: THREE.InstancedMesh }>();
  private version = -1;

  constructor(material: THREE.Material, outline: THREE.Material) {
    this.group.name = 'props';
    const defs: [number, THREE.BufferGeometry][] = [
      [PROP_PINE, pineGeo()],
      [PROP_ROUND, roundGeo()],
      [PROP_HOUSE, houseGeo()],
      [PROP_BARN, barnGeo()],
      [PROP_WINDMILL, windmillGeo()],
    ];
    for (const [type, geo] of defs) {
      const mesh = new THREE.InstancedMesh(geo, material, CAPS[type]);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const ol = new THREE.InstancedMesh(geo, outline, CAPS[type]);
      ol.instanceMatrix = mesh.instanceMatrix;
      ol.count = 0;
      ol.frustumCulled = false;
      this.group.add(mesh, ol);
      this.meshes.set(type, { mesh, outline: ol });
    }
  }

  update(chunks: ChunkManager) {
    if (chunks.propsVersion === this.version) return;
    this.version = chunks.propsVersion;
    const counts = new Map<number, number>();
    for (const t of this.meshes.keys()) counts.set(t, 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    chunks.forEachProps((cx, cz, data) => {
      for (let i = 0; i < data.length; i += PROP_STRIDE) {
        const type = data[i + 5];
        const entry = this.meshes.get(type);
        if (!entry) continue;
        const c = counts.get(type)!;
        if (c >= CAPS[type]) continue;
        p.set(cx * CHUNK_SIZE + data[i], data[i + 1], cz * CHUNK_SIZE + data[i + 2]);
        q.setFromAxisAngle(up, data[i + 4]);
        s.setScalar(data[i + 3]);
        m.compose(p, q, s);
        entry.mesh.setMatrixAt(c, m);
        counts.set(type, c + 1);
      }
    });
    for (const [type, e] of this.meshes) {
      const c = counts.get(type)!;
      e.mesh.count = c;
      e.outline.count = c;
      e.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  get instanceTotal() {
    let n = 0;
    for (const e of this.meshes.values()) n += e.mesh.count;
    return n;
  }

  dispose() {
    for (const e of this.meshes.values()) {
      e.mesh.geometry.dispose();
      e.mesh.dispose();
      e.outline.dispose();
    }
  }
}
