import * as THREE from 'three';
import { mergeParts, part, toonMesh } from '../render/geo';
import type { Airfield } from './terrain';

/**
 * Airfield visuals (design §4, upgraded in §8.3): a 900 m asphalt runway with
 * mowed grass shoulders and overruns, threshold "piano keys", runway numbers,
 * centreline, touchdown-zone bars, edge lights and PAPI approach lights, plus
 * jet-sized hangars with an apron, tents, fuel barrels and a windsock.
 */
const ASPHALT = 0x666a72;
const APRON = 0x7d8189;
const PAINT = 0xf4f1e8;
const BULB = 0xfff1b0;
const GREEN = 0x6be37a;
const PAPI_RED = new THREE.Color(0xff4a3a);
const PAPI_WHITE = new THREE.Color(0xfffdf4);

// seven-segment digits: segments a b c d e f g
const SEGS: Record<string, [number, number, number, number]> = {
  // [centre a, centre b, size a, size b] in a 1 × 2 cell (a = across, b = along)
  a: [0.5, 2, 1, 0],
  b: [1, 1.5, 0, 1],
  c: [1, 0.5, 0, 1],
  d: [0.5, 0, 1, 0],
  e: [0, 0.5, 0, 1],
  f: [0, 1.5, 0, 1],
  g: [0.5, 1, 1, 0],
};
const DIGITS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];

/** Runway designator for a landing direction (world xz), e.g. 9 → "09". */
export function runwayNumber(dx: number, dz: number): string {
  let deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  let n = Math.round(deg / 10) % 36;
  if (n === 0) n = 36;
  return String(n).padStart(2, '0');
}

interface PapiLight {
  x: number;
  z: number;
  /** +1: serves landings toward +x (the −x end); −1 the other way */
  dir: number;
  /** glide angle (rad) above which it shows white */
  angle: number;
  start: number;
  count: number;
}

export class AirfieldVisual {
  readonly group = new THREE.Group();
  readonly sock: THREE.Group;
  /** where the hangar preview parks a plane (local xz) and which way it faces */
  readonly previewSpot: THREE.Vector3;
  private papi: THREE.Mesh;
  private papiLights: PapiLight[] = [];
  private bulbMat: THREE.MeshBasicMaterial;

  constructor(
    readonly af: Airfield,
    toon: THREE.Material,
    outline: THREE.Material,
    stripMat: THREE.Material,
    markMat: THREE.Material,
  ) {
    this.group.position.set(af.x, af.height, af.z);
    // local +X runs along the runway
    this.group.rotation.y = -af.heading;

    const L = af.length;
    const W = af.width;
    const P = af.paved;
    const PW = af.pavedWidth;

    // ---------------------------------------------------- flat ground layers
    const flat: THREE.BufferGeometry[] = [];
    const n = 24;
    for (let i = 0; i < n; i++) {
      const seg = L / n;
      flat.push(part(new THREE.BoxGeometry(seg, 0.1, W), i % 2 ? 0xb4e37a : 0x93d05a, { pos: [-L / 2 + seg * (i + 0.5), 0.08, 0] }));
    }
    flat.push(part(new THREE.BoxGeometry(P, 0.1, PW), ASPHALT, { pos: [0, 0.16, 0] }));
    // painted markings float 10 cm above the asphalt (top at 0.21) in their own mesh with a
    // stronger polygon offset, so they stay on top at approach distances (no z-fighting)
    const marks: THREE.BufferGeometry[] = [];
    const mark = (x: number, z: number, lx: number, lz: number) => marks.push(part(new THREE.BoxGeometry(lx, 0.04, lz), PAINT, { pos: [x, 0.29, z] }));
    for (const s of [-1, 1]) {
      const end = s * (P / 2);
      // threshold bar and piano keys
      mark(end - s * 2, 0, 1.5, PW - 2);
      for (let k = 0; k < 4; k++) for (const side of [-1, 1]) mark(end - s * 21, side * (2.5 + k * 3.2), 30, 1.8);
      // touchdown-zone bars
      for (const side of [-1, 1]) mark(end - s * 150, side * 7, 40, 4);
      for (const side of [-1, 1]) mark(end - s * 250, side * 7, 25, 2);
    }
    // centreline
    for (let x = -P / 2 + 80; x <= P / 2 - 80; x += 40) mark(x + 10, 0, 20, 0.9);
    // runway numbers, readable by the landing pilot
    this.addNumber(mark, -1, runwayNumber(af.dirX, af.dirZ), P);
    this.addNumber(mark, 1, runwayNumber(-af.dirX, -af.dirZ), P);

    // apron in front of the hangars and a taxiway to the runway
    const side = W / 2 + 40;
    flat.push(part(new THREE.BoxGeometry(110, 0.1, 32), APRON, { pos: [-50, 0.14, side - 16] }));
    flat.push(part(new THREE.BoxGeometry(14, 0.1, side - 32 - PW / 2), APRON, { pos: [-50, 0.14, PW / 2 + (side - 32 - PW / 2) / 2] }));
    const strip = new THREE.Mesh(mergeParts(flat), stripMat);
    strip.receiveShadow = true;
    const paint = new THREE.Mesh(mergeParts(marks), markMat);
    paint.receiveShadow = true;
    this.group.add(strip, paint);

    // ------------------------------------------------------- buildings
    const hangar = (x: number, color: number) => [
      part(new THREE.BoxGeometry(34, 9, 26), color, { pos: [x, 4.5, side + 13] }),
      part(new THREE.CylinderGeometry(17, 17, 26, 12, 1, false, 0, Math.PI), 0x8d8f99, {
        pos: [x, 9, side + 13],
        rot: [Math.PI / 2, Math.PI / 2, 0],
        scale: [0.42, 1, 1],
        flat: true,
      }),
      // open door: dark inside, light frame
      part(new THREE.BoxGeometry(30, 8, 0.3), 0x3a2a20, { pos: [x, 4, side - 0.1] }),
      part(new THREE.BoxGeometry(31, 0.6, 0.5), 0xfdfbf0, { pos: [x, 8.3, side - 0.1] }),
    ];
    const parts: THREE.BufferGeometry[] = [
      ...hangar(-68, 0xd9c7a1),
      ...hangar(-30, 0xc9b38a),
      // tents
      part(new THREE.ConeGeometry(5, 5, 4), 0xf6ecd0, { pos: [20, 2.5, side + 4], rot: [0, Math.PI / 4, 0], flat: true }),
      part(new THREE.ConeGeometry(4, 4.4, 4), 0xe8d6a8, { pos: [34, 2.2, side + 6], rot: [0, Math.PI / 4, 0], flat: true }),
      // fuel barrels
      ...[0, 1, 2].map((i) => part(new THREE.CylinderGeometry(0.6, 0.6, 1.4, 8), 0xc94b32, { pos: [6 + i * 1.5, 0.7, side + 2] })),
      // windsock pole
      part(new THREE.CylinderGeometry(0.15, 0.2, 8, 6), 0xfdfbf0, { pos: [P / 2 - 120, 4, -W / 2 - 14] }),
    ];
    // edge light posts
    const lightsAt: [number, number, number][] = [];
    for (let x = -P / 2; x <= P / 2 + 0.1; x += 60)
      for (const s of [-1, 1]) {
        const z = s * (PW / 2 + 1.2);
        parts.push(part(new THREE.CylinderGeometry(0.1, 0.14, 0.7, 6), 0x3d3f45, { pos: [x, 0.35, z] }));
        lightsAt.push([x, z, Math.abs(Math.abs(x) - P / 2) < 1 ? GREEN : BULB]);
      }
    // PAPI boxes, left of each touchdown zone
    const papiPos: { x: number; z: number; dir: number; i: number }[] = [];
    for (const dir of [1, -1])
      for (let i = 0; i < 4; i++) {
        const x = -dir * (P / 2 - 150);
        const z = -dir * (PW / 2 + 8 + i * 3);
        parts.push(part(new THREE.BoxGeometry(1.4, 0.9, 1.4), 0xf2b134, { pos: [x, 0.45, z] }));
        papiPos.push({ x, z, dir, i });
      }
    if (af.home) {
      // home field flag
      parts.push(part(new THREE.CylinderGeometry(0.12, 0.15, 10, 6), 0xfdfbf0, { pos: [-110, 5, side] }));
      parts.push(part(new THREE.BoxGeometry(0.1, 2, 3.2), 0x2a9d8f, { pos: [-110, 9, side + 1.6] }));
    }
    const buildings = toonMesh(mergeParts(parts), toon, outline);
    buildings.receiveShadow = true;
    this.group.add(buildings);

    // unlit bulbs (edge lights + PAPI) so they read as glowing
    const bulbs: THREE.BufferGeometry[] = lightsAt.map(([x, z, c]) => part(new THREE.SphereGeometry(0.32, 8, 6), c, { pos: [x, 0.8, z] }));
    let start = bulbs.reduce((a, g) => a + g.getAttribute('position').count, 0);
    for (const p of papiPos) {
      const g = part(new THREE.SphereGeometry(0.42, 8, 6), 0xffffff, { pos: [p.x - p.dir * 0.7, 0.55, p.z] });
      const count = g.getAttribute('position').count;
      // inner light (nearest the runway) needs the steepest angle for white
      const angle = ((3.5 - p.i * 0.33) * Math.PI) / 180;
      this.papiLights.push({ x: p.x, z: p.z, dir: p.dir, angle, start, count });
      start += count;
      bulbs.push(g);
    }
    this.bulbMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.papi = new THREE.Mesh(mergeParts(bulbs), this.bulbMat);
    this.group.add(this.papi);

    // windsock (orange/white cone)
    this.sock = new THREE.Group();
    this.sock.position.set(P / 2 - 120, 7.6, -W / 2 - 14);
    const sockGeo = mergeParts([
      part(new THREE.CylinderGeometry(0.7, 0.35, 1.4, 8, 1, true), 0xff7a2a, { pos: [0, 0, -0.7], rot: [Math.PI / 2, 0, 0] }),
      part(new THREE.CylinderGeometry(0.35, 0.2, 1.2, 8, 1, true), 0xfdfbf0, { pos: [0, 0, -2.0], rot: [Math.PI / 2, 0, 0] }),
      part(new THREE.CylinderGeometry(0.2, 0.12, 1.0, 8, 1, true), 0xff7a2a, { pos: [0, 0, -3.1], rot: [Math.PI / 2, 0, 0] }),
    ]);
    this.sock.add(toonMesh(sockGeo, toon, outline));
    this.group.add(this.sock);

    this.previewSpot = new THREE.Vector3(-49, 0.2, side - 13);
  }

  /** Paint two seven-segment digits at one end, upright for the landing pilot. */
  private addNumber(mark: (x: number, z: number, lx: number, lz: number) => void, end: number, num: string, P: number) {
    // end −1: landing toward +x, "up" = +x and "right" = +z; end +1 mirrors both
    const up = -end;
    const base = end * (P / 2 - 48);
    const S = 5;
    const T = 1.2;
    [...num].forEach((ch, k) => {
      const a0 = (k === 0 ? -6.5 : 1.5) * up;
      for (const seg of DIGITS[+ch]) {
        const [ca, cb, sa, sb] = SEGS[seg];
        const along = base + up * ((cb - 1) * S);
        const across = a0 + up * ca * S;
        mark(along, across, sb ? S + T : T, sa ? S + T : T);
      }
    });
  }

  /** Point the sock downwind (world wind vector). */
  setWind(wind: THREE.Vector3) {
    const len = Math.hypot(wind.x, wind.z);
    if (len < 0.01) return;
    // sock geometry points along local -Z; aim it downwind in world space
    const worldYaw = Math.atan2(-wind.x, -wind.z);
    this.sock.rotation.set(-Math.min(0.9, (1 - Math.min(len / 8, 1)) * 0.9), worldYaw - this.group.rotation.y, 0, 'YXZ');
  }

  /** PAPI: each light shows white above its glide angle, red below. */
  updatePapi(world: THREE.Vector3) {
    const af = this.af;
    const dx = world.x - af.x;
    const dz = world.z - af.z;
    const lx = dx * af.dirX + dz * af.dirZ;
    const lz = -dx * af.dirZ + dz * af.dirX;
    if (Math.abs(lx) > 8000 || Math.abs(lz) > 8000) return;
    const col = this.papi.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (const l of this.papiLights) {
      const dist = (l.x - lx) * l.dir;
      const angle = Math.atan2(world.y - af.height, Math.max(dist, 1));
      const c = dist > 0 && angle < l.angle ? PAPI_RED : PAPI_WHITE;
      for (let i = l.start; i < l.start + l.count; i++) col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name !== 'outline') o.geometry.dispose();
    });
    this.bulbMat.dispose();
  }
}
