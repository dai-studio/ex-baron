import * as THREE from 'three';

/**
 * Ink outlines, method 1 (design §5): inverted hull. Back faces are pushed
 * out along a smoothed "outlineNormal" by a roughly screen-constant width that
 * thins with distance, and drawn in dark ink. Works with InstancedMesh.
 */
const vertex = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute vec3 outlineNormal;
  uniform float outlineWidth;
  uniform float maxDist;
  void main() {
    vec4 p = vec4(position, 1.0);
    vec3 n = outlineNormal;
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 mvPosition = modelViewMatrix * p;
    vec3 vn = normalize(mat3(modelViewMatrix) * n);
    float d = -mvPosition.z;
    float w = outlineWidth * 0.0028 * min(d, maxDist) * (1.0 - smoothstep(maxDist, maxDist * 3.0, d));
    mvPosition.xyz += vn * w;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragment = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform vec3 outlineColor;
  void main() {
    gl_FragColor = vec4(outlineColor, 1.0);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function outlineMaterial(color = 0x2b1d1a, width = 1, maxDist = 350): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        outlineColor: { value: new THREE.Color(color) },
        outlineWidth: { value: width },
        maxDist: { value: maxDist },
      },
    ]),
    vertexShader: vertex,
    fragmentShader: fragment,
    side: THREE.BackSide,
    fog: true,
  });
}
