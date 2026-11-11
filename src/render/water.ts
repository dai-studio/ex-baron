import * as THREE from 'three';

/**
 * Toon water (design §4 "Water"): a flat sea plane at sea level with
 * animated cartoon wave lines. It is semi-transparent so the banded depth
 * colours and white foam ring baked into the terrain show through.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          waterColor: { value: new THREE.Color(0x2f9fd0) },
          lineColor: { value: new THREE.Color(0xf4fbff) },
          time: { value: 0 },
          opacity: { value: 0.55 },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 waterColor; uniform vec3 lineColor; uniform float time; uniform float opacity;
        varying vec3 vWorld;
        void main() {
          vec2 p = vWorld.xz;
          float w = sin(p.x * 0.035 + sin(p.y * 0.021 + time * 0.4) * 2.0 + time * 0.7)
                  * sin(p.y * 0.043 + sin(p.x * 0.017 - time * 0.3) * 2.0);
          float line = smoothstep(0.84, 0.88, w) * (1.0 - smoothstep(0.93, 0.97, w));
          vec3 col = mix(waterColor, lineColor, line * 0.85);
          gl_FragColor = vec4(col, opacity + line * 0.35);
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
      transparent: true,
      fog: true,
    });
    const g = new THREE.PlaneGeometry(1, 1, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'water';
  }

  update(cam: THREE.Camera, time: number, size: number) {
    this.mesh.position.set(Math.round(cam.position.x), 0, Math.round(cam.position.z));
    this.mesh.scale.set(size, 1, size);
    this.mat.uniforms.time.value = time;
  }
}
