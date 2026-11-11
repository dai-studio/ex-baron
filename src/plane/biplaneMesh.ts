import * as THREE from 'three';
import { mergeParts, part, taperBox, toonMesh } from '../render/geo';

/**
 * Aircraft art (design §5 "Aircraft & art assets"): an original, chunky,
 * low-poly biplane built procedurally (no external models), with separate
 * nodes for the propeller, ailerons, elevator and rudder so they animate.
 * Forward is -Z.
 */
export interface Livery {
  body: number;
  accent: number;
  wing: number;
  wingUnder: number;
  emblemOuter: number;
  emblemInner: number;
}

export const PLAYER_LIVERY: Livery = {
  body: 0xf2b134,
  accent: 0x2a9d8f,
  wing: 0xf7d36e,
  wingUnder: 0xe9bf55,
  emblemOuter: 0x2a9d8f,
  emblemInner: 0xfff3c4,
};

export const ENEMY_LIVERY: Livery = {
  body: 0x7b52ab,
  accent: 0x9be15d,
  wing: 0x9a78c9,
  wingUnder: 0x8466b3,
  emblemOuter: 0x9be15d,
  emblemInner: 0x2b1b3d,
};

const METAL = 0x5d636b;
const WOOD = 0x7a4a26;
const DARK = 0x2f2a26;
const TIRE = 0x2b2b2b;

export class BiplaneVisual {
  readonly root = new THREE.Group();
  readonly prop = new THREE.Group();
  private disc: THREE.Mesh;
  private ailL = new THREE.Group();
  private ailR = new THREE.Group();
  private elev = new THREE.Group();
  private rudder = new THREE.Group();

  constructor(l: Livery, toon: THREE.Material, outline: THREE.Material) {
    const body: THREE.BufferGeometry[] = [
      // fuselage
      part(new THREE.BoxGeometry(1.05, 1.15, 2.4), l.body, { pos: [0, 0.05, -1.0] }),
      part(taperBox(1.05, 1.15, 3.7, 0.3, 0.45, 0.2), l.body, { pos: [0, 0.05, 0.2] }),
      part(new THREE.BoxGeometry(1.08, 1.18, 0.3), l.accent, { pos: [0, 0.05, 0.6] }),
      // engine cowl
      part(new THREE.CylinderGeometry(0.64, 0.6, 0.6, 14), METAL, { pos: [0, 0.05, -2.45], rot: [Math.PI / 2, 0, 0] }),
      part(new THREE.CylinderGeometry(0.66, 0.66, 0.12, 14), l.accent, { pos: [0, 0.05, -2.72], rot: [Math.PI / 2, 0, 0] }),
      // cockpit, pilot, windscreen
      part(new THREE.BoxGeometry(0.72, 0.08, 0.95), DARK, { pos: [0, 0.62, 0.0] }),
      part(new THREE.IcosahedronGeometry(0.25, 1), 0x6b4226, { pos: [0, 0.86, 0.08], flat: true }),
      part(new THREE.BoxGeometry(0.42, 0.1, 0.12), 0x9fd8ef, { pos: [0, 0.9, -0.15] }),
      part(new THREE.BoxGeometry(0.16, 0.08, 0.6), 0xfdfbf0, { pos: [0.18, 0.7, 0.42], rot: [0.2, 0.3, 0] }),
      part(new THREE.BoxGeometry(0.55, 0.28, 0.04), 0xbfe6ff, { pos: [0, 0.78, -0.55], rot: [-0.3, 0, 0] }),
      // twin guns
      part(new THREE.BoxGeometry(0.1, 0.13, 1.05), 0x30343a, { pos: [-0.22, 0.68, -1.4] }),
      part(new THREE.BoxGeometry(0.1, 0.13, 1.05), 0x30343a, { pos: [0.22, 0.68, -1.4] }),
      // wings
      part(new THREE.BoxGeometry(8.6, 0.14, 1.5), l.wing, { pos: [0, 1.5, -1.0] }),
      part(new THREE.BoxGeometry(8.0, 0.14, 1.4), l.wingUnder, { pos: [0, -0.45, -0.55] }),
      part(new THREE.BoxGeometry(0.5, 0.15, 1.52), l.accent, { pos: [-4.05, 1.5, -1.0] }),
      part(new THREE.BoxGeometry(0.5, 0.15, 1.52), l.accent, { pos: [4.05, 1.5, -1.0] }),
      // interplane + cabane struts
      ...[-2.9, 2.9].flatMap((x) => [
        part(new THREE.BoxGeometry(0.09, 1.85, 0.09), WOOD, { pos: [x, 0.52, -1.25] }),
        part(new THREE.BoxGeometry(0.09, 1.85, 0.09), WOOD, { pos: [x, 0.52, -0.45] }),
      ]),
      ...[-0.42, 0.42].flatMap((x) => [
        part(new THREE.BoxGeometry(0.07, 0.95, 0.07), WOOD, { pos: [x, 1.0, -1.4] }),
        part(new THREE.BoxGeometry(0.07, 0.95, 0.07), WOOD, { pos: [x, 1.0, -0.6] }),
      ]),
      // emblems on top & under wings
      ...[-3.0, 3.0].flatMap((x) => [
        part(new THREE.CylinderGeometry(0.62, 0.62, 0.03, 20), l.emblemOuter, { pos: [x, 1.585, -1.0] }),
        part(new THREE.CylinderGeometry(0.32, 0.32, 0.03, 20), l.emblemInner, { pos: [x, 1.6, -1.0] }),
        part(new THREE.CylinderGeometry(0.58, 0.58, 0.03, 20), l.emblemOuter, { pos: [x, -0.535, -0.55] }),
        part(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 20), l.emblemInner, { pos: [x, -0.55, -0.55] }),
      ]),
      // landing gear
      ...[-0.55, 0.55].map((x) => part(new THREE.BoxGeometry(0.08, 0.95, 0.08), WOOD, { pos: [x, -0.78, -0.6], rot: [0, 0, x > 0 ? -0.35 : 0.35] })),
      part(new THREE.BoxGeometry(1.84, 0.08, 0.08), WOOD, { pos: [0, -1.0, -0.6] }),
      ...[-0.92, 0.92].flatMap((x) => [
        part(new THREE.CylinderGeometry(0.36, 0.36, 0.17, 14), TIRE, { pos: [x, -1.0, -0.6], rot: [0, 0, Math.PI / 2] }),
        part(new THREE.CylinderGeometry(0.16, 0.16, 0.19, 10), l.accent, { pos: [x, -1.0, -0.6], rot: [0, 0, Math.PI / 2] }),
      ]),
      part(new THREE.BoxGeometry(0.06, 0.42, 0.06), WOOD, { pos: [0, -0.02, 3.78], rot: [0.45, 0, 0] }),
      // tailplane and fin
      part(new THREE.BoxGeometry(3.0, 0.08, 0.8), l.wing, { pos: [0, 0.32, 3.45] }),
      part(new THREE.BoxGeometry(0.08, 0.85, 0.75), l.accent, { pos: [0, 0.75, 3.55] }),
    ];
    this.root.add(toonMesh(mergeParts(body), toon, outline));

    // propeller
    this.prop.position.set(0, 0.05, -2.9);
    const propGeo = mergeParts([
      part(new THREE.BoxGeometry(0.2, 2.6, 0.07), WOOD, { rot: [0, 0.25, 0] }),
      part(new THREE.ConeGeometry(0.24, 0.45, 10), l.accent, { pos: [0, 0, -0.15], rot: [-Math.PI / 2, 0, 0] }),
    ]);
    this.prop.add(toonMesh(propGeo, toon, outline));
    this.root.add(this.prop);
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.32, 24),
      new THREE.MeshBasicMaterial({ color: 0xf2efe6, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.disc.position.set(0, 0.05, -2.93);
    this.root.add(this.disc);

    // control surfaces
    const ail = () => mergeParts([part(new THREE.BoxGeometry(2.2, 0.08, 0.42), l.accent, { pos: [0, 0, 0.21] })]);
    this.ailL.position.set(-3.0, 1.5, -0.25);
    this.ailR.position.set(3.0, 1.5, -0.25);
    this.ailL.add(toonMesh(ail(), toon, outline));
    this.ailR.add(toonMesh(ail(), toon, outline));
    this.elev.position.set(0, 0.32, 3.85);
    this.elev.add(toonMesh(mergeParts([part(new THREE.BoxGeometry(3.0, 0.07, 0.5), l.accent, { pos: [0, 0, 0.25] })]), toon, outline));
    this.rudder.position.set(0, 0.72, 3.92);
    this.rudder.add(toonMesh(mergeParts([part(new THREE.BoxGeometry(0.07, 1.1, 0.5), l.body, { pos: [0, 0.05, 0.25] })]), toon, outline));
    this.root.add(this.ailL, this.ailR, this.elev, this.rudder);
  }

  animate(dt: number, pitch: number, roll: number, yaw: number, rpm: number) {
    this.prop.rotation.z += rpm * 95 * dt + (rpm > 0.02 ? 6 * dt : 0);
    (this.disc.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp((rpm - 0.25) * 0.5, 0, 0.3);
    this.prop.visible = rpm < 0.75 || Math.floor(performance.now() / 30) % 3 !== 0;
    this.ailL.rotation.x = roll * 0.4;
    this.ailR.rotation.x = -roll * 0.4;
    this.elev.rotation.x = -pitch * 0.4;
    this.rudder.rotation.y = yaw * 0.45;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name !== 'outline') o.geometry.dispose();
    });
    (this.disc.material as THREE.Material).dispose();
  }
}
