import * as THREE from 'three';

/**
 * Toon lighting shader (design §5): MeshToonMaterial with a 3-band
 * gradient ramp and an added rim light for silhouettes against the sky.
 */
const ramps = new Map<string, THREE.DataTexture>();

export function gradientMap(levels: number[] = [100, 182, 255]): THREE.DataTexture {
  const key = levels.join(',');
  let tex = ramps.get(key);
  if (tex) return tex;
  const data = new Uint8Array(levels.length * 4);
  levels.forEach((v, i) => {
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  });
  tex = new THREE.DataTexture(data, levels.length, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  ramps.set(key, tex);
  return tex;
}

export interface ToonOptions {
  color?: number;
  vertexColors?: boolean;
  rim?: number;
  ramp?: number[];
  side?: THREE.Side;
  fog?: boolean;
}

export function toonMaterial(o: ToonOptions = {}): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({
    color: o.color ?? 0xffffff,
    vertexColors: !!o.vertexColors,
    gradientMap: gradientMap(o.ramp),
    side: o.side ?? THREE.FrontSide,
    fog: o.fog ?? true,
  });
  const rim = o.rim ?? 0.28;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.rimStrength = { value: rim };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float rimStrength;')
      .replace(
        '#include <opaque_fragment>',
        `{
          float rimDot = 1.0 - max(dot(normal, normalize(vViewPosition)), 0.0);
          outgoingLight += diffuseColor.rgb * rimStrength * smoothstep(0.6, 0.66, rimDot);
        }
        #include <opaque_fragment>`,
      );
  };
  m.customProgramCacheKey = () => `toon-rim-${rim}`;
  return m;
}
