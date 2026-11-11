import * as THREE from 'three';
import { mergeParts, part, toonMesh } from '../render/geo';
import type { Airfield } from './terrain';

/**
 * Airfield visuals (design §4): mowed grass strip with stripes and threshold
 * markers, hangars, tents, fuel barrels and a windsock that shows the wind.
 */
export class AirfieldVisual {
  readonly group = new THREE.Group();
  readonly sock: THREE.Group;

  constructor(af: Airfield, toon: THREE.Material, outline: THREE.Material, stripMat: THREE.Material) {
    this.group.position.set(af.x, af.height, af.z);
    // local +X runs along the runway
    this.group.rotation.y = -af.heading;

    const L = af.length;
    const W = af.width;

    // strip: alternating mowed stripes (no outline, sits just above the ground)
    const stripes: THREE.BufferGeometry[] = [];
    const n = 16;
    for (let i = 0; i < n; i++) {
      const seg = L / n;
      stripes.push(part(new THREE.BoxGeometry(seg, 0.1, W), i % 2 ? 0xb4e37a : 0x93d05a, { pos: [-L / 2 + seg * (i + 0.5), 0.1, 0] }));
    }
    for (const sx of [-1, 1])
      for (let k = -2; k <= 2; k++)
        stripes.push(part(new THREE.BoxGeometry(10, 0.12, 2.2), 0xfdfbf0, { pos: [sx * (L / 2 - 12), 0.12, k * 6] }));
    const strip = new THREE.Mesh(mergeParts(stripes), stripMat);
    strip.receiveShadow = true;
    this.group.add(strip);

    // hangars along the north side of the strip
    const side = W / 2 + 34;
    const hangar = (x: number, color: number) => [
      part(new THREE.BoxGeometry(22, 7, 18), color, { pos: [x, 3.5, side + 9] }),
      part(new THREE.CylinderGeometry(11, 11, 18, 10, 1, false, 0, Math.PI), 0x8d8f99, {
        pos: [x, 7, side + 9],
        rot: [Math.PI / 2, Math.PI / 2, 0],
        scale: [1, 1, 0.45],
        flat: true,
      }),
      part(new THREE.BoxGeometry(14, 6, 0.3), 0x4a3426, { pos: [x, 3, side - 0.1] }),
    ];
    const parts: THREE.BufferGeometry[] = [
      ...hangar(-60, 0xd9c7a1),
      ...hangar(-30, 0xc9b38a),
      // tents
      part(new THREE.ConeGeometry(5, 5, 4), 0xf6ecd0, { pos: [20, 2.5, side + 4], rot: [0, Math.PI / 4, 0], flat: true }),
      part(new THREE.ConeGeometry(4, 4.4, 4), 0xe8d6a8, { pos: [34, 2.2, side + 6], rot: [0, Math.PI / 4, 0], flat: true }),
      // fuel barrels
      ...[0, 1, 2].map((i) => part(new THREE.CylinderGeometry(0.6, 0.6, 1.4, 8), 0xc94b32, { pos: [6 + i * 1.5, 0.7, side + 2] })),
      // windsock pole
      part(new THREE.CylinderGeometry(0.15, 0.2, 8, 6), 0xfdfbf0, { pos: [L / 2 - 40, 4, -W / 2 - 14] }),
    ];
    if (af.home) {
      // home field flag
      parts.push(part(new THREE.CylinderGeometry(0.12, 0.15, 10, 6), 0xfdfbf0, { pos: [-90, 5, side] }));
      parts.push(part(new THREE.BoxGeometry(0.1, 2, 3.2), 0x2a9d8f, { pos: [-90, 9, side + 1.6] }));
    }
    const buildings = toonMesh(mergeParts(parts), toon, outline);
    buildings.receiveShadow = true;
    this.group.add(buildings);

    // windsock (orange/white cone)
    this.sock = new THREE.Group();
    this.sock.position.set(L / 2 - 40, 7.6, -W / 2 - 14);
    const sockGeo = mergeParts([
      part(new THREE.CylinderGeometry(0.7, 0.35, 1.4, 8, 1, true), 0xff7a2a, { pos: [0, 0, -0.7], rot: [Math.PI / 2, 0, 0] }),
      part(new THREE.CylinderGeometry(0.35, 0.2, 1.2, 8, 1, true), 0xfdfbf0, { pos: [0, 0, -2.0], rot: [Math.PI / 2, 0, 0] }),
      part(new THREE.CylinderGeometry(0.2, 0.12, 1.0, 8, 1, true), 0xff7a2a, { pos: [0, 0, -3.1], rot: [Math.PI / 2, 0, 0] }),
    ]);
    this.sock.add(toonMesh(sockGeo, toon, outline));
    this.group.add(this.sock);
  }

  /** Point the sock downwind (world wind vector). */
  setWind(wind: THREE.Vector3) {
    const len = Math.hypot(wind.x, wind.z);
    if (len < 0.01) return;
    // sock geometry points along local -Z; aim it downwind in world space
    const worldYaw = Math.atan2(-wind.x, -wind.z);
    this.sock.rotation.set(-Math.min(0.9, (1 - Math.min(len / 8, 1)) * 0.9), worldYaw - this.group.rotation.y, 0, 'YXZ');
  }
}
