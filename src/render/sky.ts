import * as THREE from 'three';

/** Stylised sky (design §5): gradient dome, cartoon sun disc with a banded halo. */
export interface TimeOfDay {
  name: string;
  top: number;
  horizon: number;
  bottom: number;
  sun: number;
  halo: number;
  elevation: number; // degrees
  azimuth: number; // degrees
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  ink: number;
}

export const TIMES: TimeOfDay[] = [
  {
    name: 'Morning',
    top: 0x4f9fe6, horizon: 0xd3eef8, bottom: 0xa9d3e3, sun: 0xfffbe8, halo: 0xfff6d6,
    elevation: 24, azimuth: 120, sunColor: 0xfff1d8, sunIntensity: 2.3,
    hemiSky: 0xcfe8ff, hemiGround: 0x6f8a52, hemiIntensity: 1.25, ink: 0x2e2224,
  },
  {
    name: 'Noon',
    top: 0x3d8fe0, horizon: 0xc4e6f7, bottom: 0x9cc8dc, sun: 0xffffff, halo: 0xfffbe6,
    elevation: 58, azimuth: 200, sunColor: 0xffffff, sunIntensity: 2.4,
    hemiSky: 0xd6ecff, hemiGround: 0x6b8550, hemiIntensity: 1.2, ink: 0x2b1d1a,
  },
  {
    name: 'Golden hour',
    top: 0x4a6fc4, horizon: 0xffd6a0, bottom: 0xd9b48f, sun: 0xfff3d1, halo: 0xffe2a8,
    elevation: 13, azimuth: 250, sunColor: 0xffd49a, sunIntensity: 2.2,
    hemiSky: 0xffe0bd, hemiGround: 0x6a6f4a, hemiIntensity: 1.15, ink: 0x3a2320,
  },
];

export function sunDirection(t: TimeOfDay): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(t.elevation);
  const az = THREE.MathUtils.degToRad(t.azimuth);
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
}

export class Sky {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color() },
        horizonColor: { value: new THREE.Color() },
        bottomColor: { value: new THREE.Color() },
        sunColor: { value: new THREE.Color() },
        haloColor: { value: new THREE.Color() },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 bottomColor;
        uniform vec3 sunColor; uniform vec3 haloColor; uniform vec3 sunDir;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 col = y > 0.0
            ? mix(horizonColor, topColor, pow(smoothstep(0.0, 0.65, y), 0.75))
            : mix(horizonColor, bottomColor, smoothstep(0.0, -0.25, y));
          float s = dot(d, sunDir);
          col = mix(col, haloColor, step(0.993, s) * 0.35);
          col = mix(col, haloColor, step(0.9975, s) * 0.45);
          col = mix(col, sunColor, step(0.99935, s));
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.mat);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'sky';
  }

  setTime(t: TimeOfDay) {
    const u = this.mat.uniforms;
    (u.topColor.value as THREE.Color).setHex(t.top);
    (u.horizonColor.value as THREE.Color).setHex(t.horizon);
    (u.bottomColor.value as THREE.Color).setHex(t.bottom);
    (u.sunColor.value as THREE.Color).setHex(t.sun);
    (u.haloColor.value as THREE.Color).setHex(t.halo);
    (u.sunDir.value as THREE.Vector3).copy(sunDirection(t));
  }

  follow(cam: THREE.Camera, radius: number) {
    this.mesh.position.copy(cam.position);
    this.mesh.scale.setScalar(radius);
  }
}
