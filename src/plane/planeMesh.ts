import * as THREE from 'three';
import { mergeParts, part, taperBox, toonMesh } from '../render/geo';
import { FLAP_MAX_ANGLE } from './flight';
import { AIRFRAMES, ENGINE_DEFS, WHEEL_DEFS, liveryFor, type Livery, type Loadout } from './loadout';

/**
 * Aircraft art (design §5 "Aircraft & art assets", §8.2): original, chunky,
 * low-poly planes built procedurally (no external models). Three planes,
 * each with its own engine: Biplane (2-blade wooden prop), Turboprop (4-blade
 * steel prop) and Jet (nozzle with a flame), three tyre sizes and 8 paints.
 * Separate nodes for the propeller, ailerons, flaps, elevator and rudder so
 * they animate. Forward is -Z.
 */
const METAL = 0x5d636b;
const STEEL = 0x8d939b;
const WOOD = 0x7a4a26;
const DARK = 0x2f2a26;
const TIRE = 0x2b2b2b;
const GLASS = 0x9fd8ef;

type G = THREE.BufferGeometry;
type V3 = [number, number, number];

interface Surface {
  /** hinge position */
  at: V3;
  /** fixed orientation of the hinge line (sweep), animated group sits inside */
  rot?: V3;
  geo: G;
}

interface Built {
  body: G[];
  /** pilot head and canopy: hidden in cockpit view (the camera sits at the pilot's eyes) */
  cockpit: G[];
  ailL: Surface;
  ailR: Surface;
  /** flaps on the inner trailing edge (biplane: lower wing) */
  flapL: Surface;
  flapR: Surface;
  elev: Surface;
  rudder: Surface;
}

/** Swept, tapered fin in the y-z plane: root at y = 0, tip at y = h. */
function finGeo(h: number, root: number, tip: number, sweep: number, thick: number): G {
  const g = new THREE.BoxGeometry(thick, h, root);
  g.translate(0, h / 2, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > h / 2) p.setZ(i, (p.getZ(i) * tip) / root + sweep);
  }
  g.computeVertexNormals();
  return g;
}

const wheelParts = (at: V3, r: number, w: number, hub: number): G[] => [
  part(new THREE.CylinderGeometry(r, r, w, 14), TIRE, { pos: at, rot: [0, 0, Math.PI / 2] }),
  part(new THREE.CylinderGeometry(r * 0.45, r * 0.45, w + 0.02, 10), hub, { pos: at, rot: [0, 0, Math.PI / 2] }),
];

const emblem = (x: number, y: number, z: number, r: number, l: Livery, under = false): G[] => [
  part(new THREE.CylinderGeometry(r, r, 0.03, 20), l.emblemOuter, { pos: [x, y, z] }),
  part(new THREE.CylinderGeometry(r * 0.52, r * 0.52, 0.03, 20), l.emblemInner, { pos: [x, y + (under ? -0.015 : 0.015), z] }),
];

// ------------------------------------------------------------------ biplane

function buildBiplane(l: Livery): Built {
  const body: G[] = [
    // fuselage
    part(new THREE.BoxGeometry(1.05, 1.15, 2.4), l.body, { pos: [0, 0.05, -1.0] }),
    part(taperBox(1.05, 1.15, 3.7, 0.3, 0.45, 0.2), l.body, { pos: [0, 0.05, 0.2] }),
    part(new THREE.BoxGeometry(1.08, 1.18, 0.3), l.accent, { pos: [0, 0.05, 0.6] }),
    // engine cowl
    part(new THREE.CylinderGeometry(0.64, 0.6, 0.6, 14), METAL, { pos: [0, 0.05, -2.45], rot: [Math.PI / 2, 0, 0] }),
    part(new THREE.CylinderGeometry(0.66, 0.66, 0.12, 14), l.accent, { pos: [0, 0.05, -2.72], rot: [Math.PI / 2, 0, 0] }),
    // cockpit, pilot, scarf, windscreen
    part(new THREE.BoxGeometry(0.72, 0.08, 0.95), DARK, { pos: [0, 0.62, 0.0] }),
    // wings
    part(new THREE.BoxGeometry(8.6, 0.14, 1.5), l.wing, { pos: [0, 1.5, -1.0] }),
    part(new THREE.BoxGeometry(8.0, 0.14, 1.4), l.wingUnder, { pos: [0, -0.45, -0.55] }),
    // wingtip caps wrap the wing and stick out past its end, so no faces are shared (no z-fighting)
    part(new THREE.BoxGeometry(0.56, 0.18, 1.56), l.stripe ?? l.accent, { pos: [-4.05, 1.5, -1.0] }),
    part(new THREE.BoxGeometry(0.56, 0.18, 1.56), l.stripe ?? l.accent, { pos: [4.05, 1.5, -1.0] }),
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
    ...[-3.0, 3.0].flatMap((x) => [...emblem(x, 1.585, -1.0, 0.62, l), ...emblem(x, -0.535, -0.55, 0.58, l, true)]),
    // landing gear legs + axle
    ...[-0.55, 0.55].map((x) => part(new THREE.BoxGeometry(0.08, 0.95, 0.08), WOOD, { pos: [x, -0.78, -0.6], rot: [0, 0, x > 0 ? -0.35 : 0.35] })),
    part(new THREE.BoxGeometry(1.84, 0.08, 0.08), WOOD, { pos: [0, -1.0, -0.6] }),
    part(new THREE.BoxGeometry(0.06, 0.42, 0.06), WOOD, { pos: [0, -0.02, 3.78], rot: [0.45, 0, 0] }),
    // tailplane and fin
    part(new THREE.BoxGeometry(3.0, 0.08, 0.8), l.wing, { pos: [0, 0.32, 3.45] }),
    part(new THREE.BoxGeometry(0.08, 0.85, 0.75), l.accent, { pos: [0, 0.75, 3.55] }),
  ];
  if (l.stripe) body.push(part(new THREE.BoxGeometry(1.09, 0.2, 2.3), l.stripe, { pos: [0, -0.15, -1.0] }));
  return {
    body,
    // pilot (head, goggles, scarf) and windscreen
    cockpit: [
      part(new THREE.IcosahedronGeometry(0.25, 1), 0x6b4226, { pos: [0, 0.86, 0.08], flat: true }),
      part(new THREE.BoxGeometry(0.42, 0.1, 0.12), GLASS, { pos: [0, 0.9, -0.15] }),
      part(new THREE.BoxGeometry(0.16, 0.08, 0.6), 0xfdfbf0, { pos: [0.18, 0.7, 0.42], rot: [0.2, 0.3, 0] }),
      part(new THREE.BoxGeometry(0.55, 0.28, 0.04), 0xbfe6ff, { pos: [0, 0.78, -0.55], rot: [-0.3, 0, 0] }),
    ],
    ailL: { at: [-3.0, 1.5, -0.25], geo: part(new THREE.BoxGeometry(2.2, 0.08, 0.42), l.accent, { pos: [0, 0, 0.21] }) },
    ailR: { at: [3.0, 1.5, -0.25], geo: part(new THREE.BoxGeometry(2.2, 0.08, 0.42), l.accent, { pos: [0, 0, 0.21] }) },
    flapL: { at: [-1.75, -0.45, 0.15], geo: part(new THREE.BoxGeometry(2.0, 0.08, 0.38), l.accent, { pos: [0, 0, 0.19] }) },
    flapR: { at: [1.75, -0.45, 0.15], geo: part(new THREE.BoxGeometry(2.0, 0.08, 0.38), l.accent, { pos: [0, 0, 0.19] }) },
    elev: { at: [0, 0.32, 3.85], geo: part(new THREE.BoxGeometry(2.9, 0.07, 0.5), l.accent, { pos: [0, 0, 0.25] }) },
    rudder: { at: [0, 0.72, 3.92], geo: part(new THREE.BoxGeometry(0.07, 1.1, 0.5), l.body, { pos: [0, 0.05, 0.25] }) },
  };
}

// ---------------------------------------------------------------- turboprop

function buildTurboprop(l: Livery): Built {
  const body: G[] = [
    // nose cowl + fuselage
    part(new THREE.CylinderGeometry(0.6, 0.68, 1.0, 14), l.body, { pos: [0, 0.05, -3.05], rot: [Math.PI / 2, 0, 0] }),
    part(new THREE.CylinderGeometry(0.62, 0.62, 0.12, 14), l.accent, { pos: [0, 0.05, -3.5], rot: [Math.PI / 2, 0, 0] }),
    // turbine exhaust stacks
    ...[-1, 1].map((sx) => part(new THREE.BoxGeometry(0.16, 0.16, 0.5), METAL, { pos: [sx * 0.66, -0.1, -2.65], rot: [0.3, 0, 0] })),
    part(new THREE.BoxGeometry(1.3, 1.3, 2.6), l.body, { pos: [0, 0, -1.3] }),
    part(taperBox(1.3, 1.3, 4.3, 0.35, 0.5, 0.25), l.body, { pos: [0, 0, 0] }),
    part(new THREE.BoxGeometry(1.33, 1.33, 0.3), l.accent, { pos: [0, 0, 0.9] }),
    // low wing
    part(new THREE.BoxGeometry(9.8, 0.18, 1.8), l.wing, { pos: [0, -0.42, -0.2] }),
    part(new THREE.BoxGeometry(9.6, 0.04, 1.7), l.wingUnder, { pos: [0, -0.53, -0.2] }),
    part(new THREE.BoxGeometry(0.56, 0.24, 1.86), l.stripe ?? l.accent, { pos: [-4.65, -0.42, -0.2] }),
    part(new THREE.BoxGeometry(0.56, 0.24, 1.86), l.stripe ?? l.accent, { pos: [4.65, -0.42, -0.2] }),
    ...[-3.1, 3.1].flatMap((x) => emblem(x, -0.315, -0.3, 0.55, l)),
    // tail
    part(new THREE.BoxGeometry(3.6, 0.08, 0.9), l.wing, { pos: [0, 0.3, 3.7] }),
    part(finGeo(1.4, 1.5, 0.8, 0.55, 0.1), l.accent, { pos: [0, 0.35, 3.6], flat: true }),
    // tricycle gear legs
    ...[-1.35, 1.35].map((x) => part(new THREE.BoxGeometry(0.1, 0.55, 0.1), METAL, { pos: [x, -0.78, 0.35] })),
    part(new THREE.BoxGeometry(0.1, 0.45, 0.1), METAL, { pos: [0, -0.85, -2.5] }),
  ];
  if (l.stripe) body.push(part(new THREE.BoxGeometry(1.33, 0.22, 2.5), l.stripe, { pos: [0, -0.1, -1.3] }));
  return {
    body,
    // bubble canopy with pilot
    cockpit: [
      part(new THREE.IcosahedronGeometry(0.62, 1), GLASS, { pos: [0, 0.55, -0.7], scale: [0.85, 0.72, 1.55], flat: true }),
      part(new THREE.IcosahedronGeometry(0.22, 1), 0x6b4226, { pos: [0, 0.75, -0.55], flat: true }),
    ],
    ailL: { at: [-3.6, -0.42, 0.7], geo: part(new THREE.BoxGeometry(2.4, 0.09, 0.42), l.accent, { pos: [0, 0, 0.21] }) },
    ailR: { at: [3.6, -0.42, 0.7], geo: part(new THREE.BoxGeometry(2.4, 0.09, 0.42), l.accent, { pos: [0, 0, 0.21] }) },
    flapL: { at: [-1.6, -0.42, 0.7], geo: part(new THREE.BoxGeometry(1.6, 0.09, 0.42), l.accent, { pos: [0, 0, 0.21] }) },
    flapR: { at: [1.6, -0.42, 0.7], geo: part(new THREE.BoxGeometry(1.6, 0.09, 0.42), l.accent, { pos: [0, 0, 0.21] }) },
    elev: { at: [0, 0.3, 4.15], geo: part(new THREE.BoxGeometry(3.5, 0.07, 0.45), l.accent, { pos: [0, 0, 0.22] }) },
    rudder: { at: [0, 1.05, 4.6], rot: [0.37, 0, 0], geo: part(new THREE.BoxGeometry(0.09, 1.2, 0.4), l.body, { pos: [0, 0, 0.2] }) },
  };
}

// ---------------------------------------------------------------------- jet

function buildJet(l: Livery): Built {
  const sweep = 0.45;
  const halfWing = (side: number) => [
    part(new THREE.BoxGeometry(4.2, 0.14, 2.2), l.wing, { pos: [side * 2.39, -0.15, 1.11], rot: [0, -side * sweep, 0] }),
    part(new THREE.BoxGeometry(0.45, 0.2, 1.4), l.stripe ?? l.accent, { pos: [side * 4.15, -0.15, 2.0], rot: [0, -side * sweep, 0] }),
    ...emblem(side * 2.5, -0.07, 1.2, 0.5, l),
    // swept tailplane
    part(new THREE.BoxGeometry(1.7, 0.08, 1.0), l.wing, { pos: [side * 1.1, 0.1, 3.85], rot: [0, -side * 0.4, 0] }),
  ];
  const body: G[] = [
    part(new THREE.ConeGeometry(0.55, 1.6, 12), l.body, { pos: [0, 0, -4.8], rot: [-Math.PI / 2, 0, 0] }),
    part(new THREE.BoxGeometry(1.1, 1.1, 4.0), l.body, { pos: [0, 0, -2.0] }),
    part(taperBox(1.1, 1.1, 4.2, 0.95, 0.95, 0.05), l.body, { pos: [0, 0, 0] }),
    part(new THREE.BoxGeometry(1.13, 1.13, 0.25), l.accent, { pos: [0, 0, -3.6] }),
    // side intakes
    ...[-1, 1].flatMap((sx) => [
      part(new THREE.BoxGeometry(0.45, 0.7, 1.6), l.body, { pos: [sx * 0.75, -0.05, -1.4] }),
      part(new THREE.BoxGeometry(0.36, 0.56, 0.05), DARK, { pos: [sx * 0.78, -0.05, -2.21] }),
    ]),
    ...halfWing(-1),
    ...halfWing(1),
    // fin
    part(finGeo(1.9, 2.2, 0.9, 1.2, 0.12), l.accent, { pos: [0, 0.4, 3.2], flat: true }),
    // nozzle
    part(new THREE.CylinderGeometry(0.5, 0.42, 0.7, 12), METAL, { pos: [0, 0.05, 4.4], rot: [Math.PI / 2, 0, 0] }),
    part(new THREE.CylinderGeometry(0.33, 0.33, 0.05, 12), DARK, { pos: [0, 0.05, 4.76], rot: [Math.PI / 2, 0, 0] }),
    // tricycle gear legs
    ...[-1.3, 1.3].map((x) => part(new THREE.BoxGeometry(0.1, 0.7, 0.1), METAL, { pos: [x, -0.55, 0.7] })),
    part(new THREE.BoxGeometry(0.1, 0.45, 0.1), METAL, { pos: [0, -0.7, -2.9] }),
  ];
  if (l.stripe) body.push(part(new THREE.BoxGeometry(1.16, 0.2, 3.9), l.stripe, { pos: [0, -0.1, -2.0] }));
  return {
    body,
    // canopy + pilot
    cockpit: [
      part(new THREE.IcosahedronGeometry(0.55, 1), GLASS, { pos: [0, 0.55, -2.4], scale: [0.85, 0.7, 2.0], flat: true }),
      part(new THREE.IcosahedronGeometry(0.2, 1), 0x6b4226, { pos: [0, 0.72, -2.3], flat: true }),
    ],
    ailL: { at: [-3.1, -0.15, 1.95], rot: [0, sweep, 0], geo: part(new THREE.BoxGeometry(1.8, 0.08, 0.4), l.accent, { pos: [0, 0, 0.2] }) },
    ailR: { at: [3.1, -0.15, 1.95], rot: [0, -sweep, 0], geo: part(new THREE.BoxGeometry(1.8, 0.08, 0.4), l.accent, { pos: [0, 0, 0.2] }) },
    // inboard of the ailerons on the swept trailing edge (wing-local x −1..0, hinge 0.6 m aft of mid-chord)
    flapL: { at: [-1.68, -0.15, 1.43], rot: [0, sweep, 0], geo: part(new THREE.BoxGeometry(1.0, 0.08, 0.45), l.accent, { pos: [0, 0, 0.225] }) },
    flapR: { at: [1.68, -0.15, 1.43], rot: [0, -sweep, 0], geo: part(new THREE.BoxGeometry(1.0, 0.08, 0.45), l.accent, { pos: [0, 0, 0.225] }) },
    elev: { at: [0, 0.1, 4.3], geo: part(new THREE.BoxGeometry(3.4, 0.07, 0.4), l.accent, { pos: [0, 0, 0.2] }) },
    rudder: { at: [0, 1.25, 4.55], rot: [0.52, 0, 0], geo: part(new THREE.BoxGeometry(0.1, 1.3, 0.4), l.body, { pos: [0, 0, 0.2] }) },
  };
}

const BUILDERS = { biplane: buildBiplane, turboprop: buildTurboprop, jet: buildJet };

// ------------------------------------------------------------- the visual

export class PlaneVisual {
  readonly root = new THREE.Group();
  readonly prop = new THREE.Group();
  readonly livery: Livery;
  private disc: THREE.Mesh | null = null;
  private flames: THREE.Group[] = [];
  private flameMat: THREE.MeshBasicMaterial | null = null;
  private ailL = new THREE.Group();
  private ailR = new THREE.Group();
  private flapL = new THREE.Group();
  private flapR = new THREE.Group();
  private elev = new THREE.Group();
  private rudder = new THREE.Group();
  private hasProp: boolean;
  private cockpit: THREE.Mesh;
  /** instrument panel across the bottom of the cockpit view (only shown in cockpit view) */
  private dash = new THREE.Group();
  private rpmNeedle = new THREE.Group();
  private dashMat: THREE.MeshToonMaterial | null = null;

  constructor(readonly loadout: Loadout, toon: THREE.Material, outline: THREE.Material) {
    const l = liveryFor(loadout.paint);
    this.livery = l;
    const af = AIRFRAMES[loadout.style];
    const wd = WHEEL_DEFS[loadout.wheels];
    const b = BUILDERS[loadout.style](l);
    const parts = b.body;

    // wheels (axle heights are fixed per airframe; tyre size from the wheel choice)
    for (const m of af.mains) parts.push(...wheelParts(m, wd.radius, wd.width, l.accent));
    if (af.gear === 'tricycle') parts.push(...wheelParts(af.third, wd.radius * 0.85, wd.width * 0.9, l.accent));

    this.root.add(toonMesh(mergeParts(parts), toon, outline));
    this.cockpit = toonMesh(mergeParts(b.cockpit), toon, outline);
    this.root.add(this.cockpit);
    this.buildDash(af.eye, l, toon);

    // the engine that comes with the style: wooden prop, turbo prop or jet flame
    const engine = af.engine;
    const mount = af.engineMount;
    const pr = ENGINE_DEFS[engine].propRadius;
    this.hasProp = pr > 0;
    if (engine === 'jet') {
      this.flameMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, depthWrite: false });
      const core = new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.95, depthWrite: false });
      // after rotateX the cone's base is at the nozzle and its tip points back (+Z)
      const outer = new THREE.ConeGeometry(0.45, 2.2, 10).rotateX(Math.PI / 2).translate(0, 0, 1.1);
      const inner = new THREE.ConeGeometry(0.25, 1.4, 8).rotateX(Math.PI / 2).translate(0, 0, 0.7);
      const fg = new THREE.Group();
      fg.position.set(...mount);
      fg.add(new THREE.Mesh(outer, this.flameMat), new THREE.Mesh(inner, core));
      this.flames.push(fg);
      this.root.add(fg);
    } else {
      this.prop.position.set(...mount);
      const blades: G[] =
        engine === 'turbo'
          ? [
              part(new THREE.BoxGeometry(0.18, pr * 2, 0.06), STEEL, { rot: [0, 0.3, 0] }),
              part(new THREE.BoxGeometry(pr * 2, 0.18, 0.06), STEEL, { rot: [0.3, 0, 0] }),
              part(new THREE.ConeGeometry(0.3, 0.7, 12), l.accent, { pos: [0, 0, -0.25], rot: [-Math.PI / 2, 0, 0] }),
            ]
          : [
              part(new THREE.BoxGeometry(0.2, pr * 2, 0.07), WOOD, { rot: [0, 0.25, 0] }),
              part(new THREE.ConeGeometry(0.24, 0.45, 10), l.accent, { pos: [0, 0, -0.15], rot: [-Math.PI / 2, 0, 0] }),
            ];
      this.prop.add(toonMesh(mergeParts(blades), toon, outline));
      this.root.add(this.prop);
      this.disc = new THREE.Mesh(
        new THREE.CircleGeometry(pr + 0.02, 24),
        new THREE.MeshBasicMaterial({ color: 0xf2efe6, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
      );
      this.disc.position.set(mount[0], mount[1], mount[2] - 0.03);
      this.root.add(this.disc);
    }

    // control surfaces (a fixed hinge group holds the animated group)
    const surf = (s: Surface, g: THREE.Group) => {
      const hinge = new THREE.Group();
      hinge.position.set(...s.at);
      if (s.rot) hinge.rotation.set(...s.rot);
      g.add(toonMesh(mergeParts([s.geo]), toon, outline));
      hinge.add(g);
      this.root.add(hinge);
    };
    surf(b.ailL, this.ailL);
    surf(b.ailR, this.ailR);
    surf(b.flapL, this.flapL);
    surf(b.flapR, this.flapR);
    surf(b.elev, this.elev);
    surf(b.rudder, this.rudder);
  }

  private cockpitView = false;

  /**
   * In cockpit view the camera is at the pilot's eyes: hide the head and canopy, and the
   * plane's own ink outlines (from inside a clipped part they would show as solid black).
   */
  setCockpitView(on: boolean) {
    if (on === this.cockpitView) return;
    this.cockpitView = on;
    this.cockpit.visible = !on;
    this.dash.visible = on;
    this.root.traverse((o) => {
      if (o.name === 'outline') o.visible = !on;
    });
  }

  /**
   * Cockpit dashboard, placed relative to the pilot's eye: a wide panel 0.8 m ahead whose top
   * edge sits ~20° below eye level, so the bottom of the screen shows the cockpit, not the
   * landscape, while the horizon and the runway ahead stay visible. Wide enough for 21:9 screens.
   */
  private buildDash(eye: V3, l: Livery, toon: THREE.Material) {
    const W = 3.6;
    const H = 0.6;
    const parts: G[] = [
      part(new THREE.BoxGeometry(W, H, 0.08), 0x3b2e28, {}),
      // padded rim in the paint colour
      part(new THREE.BoxGeometry(W + 0.04, 0.07, 0.14), l.body, { pos: [0, H / 2, 0.01] }),
    ];
    const gauges: [number, number][] = [
      [-0.3, 0.1],
      [0, 0.12],
      [0.3, 0.1],
    ];
    for (const [x, y] of gauges) {
      parts.push(part(new THREE.CylinderGeometry(0.085, 0.085, 0.02, 20), 0x1e1814, { pos: [x, y, 0.05], rot: [Math.PI / 2, 0, 0] }));
      parts.push(part(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 20), 0xfdf3d6, { pos: [x, y, 0.056], rot: [Math.PI / 2, 0, 0] }));
    }
    const tilt = new THREE.Group();
    tilt.position.set(eye[0], eye[1] - 0.6, eye[2] - 0.8);
    tilt.rotation.x = -0.2; // top leans away from the pilot
    // Nothing sits between the pilot's eyes and the dashboard, so draw it last and on top of
    // the scene (it still writes depth, so the ink-edge pass outlines it and not what is behind).
    this.dashMat = (toon as THREE.MeshToonMaterial).clone();
    // depthFunc ALWAYS (not depthTest = false, which in WebGL also stops depth writes)
    this.dashMat.depthFunc = THREE.AlwaysDepth;
    const panel = new THREE.Mesh(mergeParts(parts), this.dashMat);
    panel.renderOrder = 10;
    tilt.add(panel);
    // the middle gauge shows engine RPM
    this.rpmNeedle.position.set(0, 0.12, 0.07);
    const needle = new THREE.Mesh(mergeParts([part(new THREE.BoxGeometry(0.012, 0.06, 0.006), 0xd94a3d, { pos: [0, 0.03, 0] })]), this.dashMat);
    needle.renderOrder = 11;
    this.rpmNeedle.add(needle);
    tilt.add(this.rpmNeedle);
    this.dash.add(tilt);
    this.dash.visible = false;
    this.root.add(this.dash);
  }

  animate(dt: number, pitch: number, roll: number, yaw: number, rpm: number, flaps = 0) {
    if (this.dash.visible) this.rpmNeedle.rotation.z = 2.2 - rpm * 4.4;
    if (this.hasProp) {
      this.prop.rotation.z += rpm * 95 * dt + (rpm > 0.02 ? 6 * dt : 0);
      (this.disc!.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp((rpm - 0.25) * 0.5, 0, 0.3);
      this.prop.visible = rpm < 0.75 || Math.floor(performance.now() / 30) % 3 !== 0;
    }
    if (this.flames.length) {
      const flick = 0.85 + 0.15 * Math.sin(performance.now() * 0.05) * Math.sin(performance.now() * 0.031);
      const len = Math.max(0.05, (rpm - 0.08) * 1.25) * flick;
      for (const f of this.flames) {
        f.visible = rpm > 0.1;
        f.scale.set(0.6 + rpm * 0.4, 0.6 + rpm * 0.4, len);
      }
      this.flameMat!.opacity = 0.5 + rpm * 0.4;
    }
    this.ailL.rotation.x = roll * 0.4;
    this.ailR.rotation.x = -roll * 0.4;
    // trailing edge down
    this.flapL.rotation.x = this.flapR.rotation.x = flaps * FLAP_MAX_ANGLE;
    this.elev.rotation.x = -pitch * 0.4;
    this.rudder.rotation.y = yaw * 0.45;
  }

  dispose() {
    const mats = new Set<THREE.Material>();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (o.name !== 'outline') o.geometry.dispose();
        if (o.material instanceof THREE.MeshBasicMaterial) mats.add(o.material);
      }
    });
    for (const m of mats) m.dispose();
    this.dashMat?.dispose();
  }
}
