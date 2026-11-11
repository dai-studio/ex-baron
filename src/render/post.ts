import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

/**
 * Post-processing (design §5): scene → (colour + depth) → ink edge pass →
 * FXAA → screen. Edges come from a Laplacian on inverse view depth, which is
 * zero on flat surfaces and large at silhouettes and creases, so it draws
 * ridge lines on the terrain and clouds without lines on flat ground.
 */
const edgeFrag = /* glsl */ `
  #include <packing>
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 texel;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform vec3 inkColor;
  uniform float strength;
  uniform float threshLo;
  uniform float threshHi;
  uniform float fadeStart;
  uniform float fadeEnd;
  uniform float saturation;
  varying vec2 vUv;

  float invZ(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    return 1.0 / max(-perspectiveDepthToViewZ(d, cameraNear, cameraFar), 0.001);
  }

  vec3 toSRGB(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  void main() {
    vec3 c = texture2D(tColor, vUv).rgb;
    float ic = invZ(vUv);
    float s = 0.0;
    s += invZ(vUv + texel * vec2(-1.0, -1.0));
    s += invZ(vUv + texel * vec2( 0.0, -1.0));
    s += invZ(vUv + texel * vec2( 1.0, -1.0));
    s += invZ(vUv + texel * vec2(-1.0,  0.0));
    s += invZ(vUv + texel * vec2( 1.0,  0.0));
    s += invZ(vUv + texel * vec2(-1.0,  1.0));
    s += invZ(vUv + texel * vec2( 0.0,  1.0));
    s += invZ(vUv + texel * vec2( 1.0,  1.0));
    float lap = abs(s - 8.0 * ic) / ic;
    float e = smoothstep(threshLo, threshHi, lap);
    float z = 1.0 / ic;
    e *= 1.0 - smoothstep(fadeStart, fadeEnd, z);
    vec3 col = mix(c, inkColor, e * strength);
    // light colour grade: saturation boost
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(mix(vec3(l), col, saturation), 0.0);
    gl_FragColor = vec4(toSRGB(col), 1.0);
  }
`;

export class PostFX {
  private rt: THREE.WebGLRenderTarget;
  private rt2: THREE.WebGLRenderTarget;
  private edge: FullScreenQuad;
  private fxaa: FullScreenQuad;
  private edgeMat: THREE.ShaderMaterial;
  private fxaaMat: THREE.ShaderMaterial;

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.rt.depthTexture = new THREE.DepthTexture(1, 1);
    this.rt.depthTexture.type = THREE.UnsignedIntType;
    this.rt2 = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType });

    this.edgeMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.rt.texture },
        tDepth: { value: this.rt.depthTexture },
        texel: { value: new THREE.Vector2() },
        cameraNear: { value: 0.5 },
        cameraFar: { value: 5000 },
        inkColor: { value: new THREE.Color(0x2b1d1a) },
        strength: { value: 0.85 },
        threshLo: { value: 0.035 },
        threshHi: { value: 0.12 },
        fadeStart: { value: 900 },
        fadeEnd: { value: 3200 },
        saturation: { value: 1.0 },
      },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: edgeFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.edge = new FullScreenQuad(this.edgeMat);

    this.fxaaMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms),
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: FXAAShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.fxaaMat.uniforms.tDiffuse.value = this.rt2.texture;
    this.fxaa = new FullScreenQuad(this.fxaaMat);
  }

  setInk(hex: number) {
    (this.edgeMat.uniforms.inkColor.value as THREE.Color).setHex(hex);
  }

  setFade(start: number, end: number) {
    this.edgeMat.uniforms.fadeStart.value = start;
    this.edgeMat.uniforms.fadeEnd.value = end;
  }

  setSize(w: number, h: number) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    this.rt.setSize(w, h);
    this.rt2.setSize(w, h);
    (this.edgeMat.uniforms.texel.value as THREE.Vector2).set(1 / w, 1 / h);
    (this.fxaaMat.uniforms.resolution.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.edgeMat.uniforms.cameraNear.value = camera.near;
    this.edgeMat.uniforms.cameraFar.value = camera.far;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(this.rt2);
    this.edge.render(renderer);
    renderer.setRenderTarget(null);
    this.fxaa.render(renderer);
  }

  dispose() {
    this.rt.dispose();
    this.rt2.dispose();
    this.edge.dispose();
    this.fxaa.dispose();
  }
}
