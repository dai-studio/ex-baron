import * as THREE from 'three';
import type { RoutePoint } from '../game/route';

/**
 * Guide arrows (plan step 21): transparent white chevrons hanging in the air
 * along a cross-country route (or a skywriting path, with the smoke
 * segments in orange), pointing the way. One instanced draw call.
 * Each chevron is tilted up so it reads from behind as well as from above.
 * The shader shows only the stretch just ahead of the plane: arrows behind
 * fade out, distant ones fade in, ones right next to the camera fade so
 * flying through them doesn't flash the screen white, and a soft wave runs
 * along them in the direction of travel.
 */
const SPACING = 120; // m between arrows
const AHEAD = 3600; // m of path shown ahead of the plane (cross-country)

export interface GuideOptions {
  spacing?: number;
  ahead?: number;
  /** stretches of the path (s0, s1) drawn in the hot colour: skywriting smoke segments */
  hot?: { s0: number; s1: number }[];
  hotColor?: number;
}
const TILT = (55 * Math.PI) / 180;

const vert = /* glsl */ `
  attribute float aS;
  attribute float aHot;
  varying float vS;
  varying float vHot;
  varying float vDist;
  void main() {
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vS = aS;
    vHot = aHot;
    vDist = distance(wp.xyz, cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const frag = /* glsl */ `
  uniform float uProgress;
  uniform float uAhead;
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying float vS;
  varying float vHot;
  varying float vDist;
  void main() {
    float a = uOpacity;
    a *= smoothstep(uProgress - 40.0, uProgress + 60.0, vS);   // passed arrows go
    a *= 1.0 - smoothstep(uProgress + uAhead * 0.7, uProgress + uAhead, vS); // the far ones fade in
    a *= smoothstep(12.0, 55.0, vDist);                         // don't white out the camera
    a *= 0.72 + 0.28 * sin(vS * 0.018 - uTime * 3.2);           // a wave running forward
    if (a < 0.01) discard;
    gl_FragColor = vec4(mix(uColor, uHot, vHot), a);
  }
`;

/** Flat chevron, 14 m wide, pointing along +z, lying in the xz plane; `grow` widens it for the outline. */
function chevronGeometry(grow = 1): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 3.2);
  s.lineTo(7, -3.6);
  s.lineTo(7, -6.4);
  s.lineTo(0, 0.2);
  s.lineTo(-7, -6.4);
  s.lineTo(-7, -3.6);
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.translate(0, 1.6, 0);
  g.scale(grow, grow, 1);
  g.translate(0, -1.6, 0);
  g.rotateX(Math.PI / 2); // shape +y → +z (forward), lying flat
  g.rotateX(-TILT); // tip up, so it shows as a "^" from behind
  return g;
}

function arrowMaterial(color: number, hot: number, opacity: number, ahead: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uProgress: { value: 0 },
      uAhead: { value: ahead },
      uTime: { value: 0 },
      uOpacity: { value: opacity },
      uColor: { value: new THREE.Color(color) },
      uHot: { value: new THREE.Color(hot) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export class GuideArrows {
  /** white arrows over a soft ink outline (so they read against pale sky and cloud) */
  readonly mesh = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private meshes: THREE.InstancedMesh[] = [];

  /** Arrows along `pts` from 60 m in to `end` (cross-country: the touchdown + 100 m). */
  constructor(pts: RoutePoint[], end: number, o: GuideOptions = {}) {
    const spacing = o.spacing ?? SPACING;
    const hot = o.hot ?? [];
    const at: number[] = [];
    for (let d = 60; d < end; d += spacing) at.push(d);
    const count = at.length;
    const sAttr = new Float32Array(count);
    const hotAttr = new Float32Array(count);
    for (const [grow, color, hotColor, opacity, order] of [
      [1.14, 0x2b1d1a, 0x2b1d1a, 0.3, 4],
      [1, 0xffffff, o.hotColor ?? 0xff7a3d, 0.8, 5],
    ] as const) {
      const geo = chevronGeometry(grow);
      const mat = arrowMaterial(color, hotColor, opacity, o.ahead ?? AHEAD);
      const im = new THREE.InstancedMesh(geo, mat, count);
      im.frustumCulled = false;
      im.renderOrder = order;
      this.geos.push(geo);
      this.mats.push(mat);
      this.meshes.push(im);
      this.mesh.add(im);
    }
    const m = new THREE.Matrix4();
    const fwd = new THREE.Vector3();
    const up = new THREE.Vector3();
    const right = new THREE.Vector3();
    const pos = new THREE.Vector3();
    let j = 0;
    for (let k = 0; k < count; k++) {
      const d = at[k];
      while (j < pts.length - 2 && pts[j + 1].s < d) j++;
      const a = pts[j];
      const b = pts[j + 1];
      const t = (d - a.s) / (b.s - a.s || 1);
      pos.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
      // direction: average over ±40 m so the arrows follow the curve smoothly
      const i0 = Math.max(0, j - 2);
      const i1 = Math.min(pts.length - 1, j + 3);
      fwd.set(pts[i1].x - pts[i0].x, pts[i1].y - pts[i0].y, pts[i1].z - pts[i0].z).normalize();
      right.crossVectors(up.set(0, 1, 0), fwd).normalize();
      up.crossVectors(fwd, right);
      m.makeBasis(right, up, fwd).setPosition(pos);
      for (const im of this.meshes) im.setMatrixAt(k, m);
      sAttr[k] = d;
      hotAttr[k] = hot.some((h) => d >= h.s0 - 5 && d <= h.s1 + 5) ? 1 : 0;
    }
    for (const g of this.geos) {
      g.setAttribute('aS', new THREE.InstancedBufferAttribute(sAttr, 1));
      g.setAttribute('aHot', new THREE.InstancedBufferAttribute(hotAttr, 1));
    }
    for (const im of this.meshes) im.instanceMatrix.needsUpdate = true;
  }

  update(progress: number, time: number) {
    for (const mt of this.mats) {
      mt.uniforms.uProgress.value = progress;
      mt.uniforms.uTime.value = time;
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const mt of this.mats) mt.dispose();
    for (const im of this.meshes) im.dispose();
  }
}
