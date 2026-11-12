import * as THREE from 'three';

/**
 * Camera rig (design §3): spring-lagged chase cam with FOV kick, cockpit
 * view, cinematic orbit (title/crash), and shake on impacts.
 */
export type CamMode = 'chase' | 'cockpit';

const _off = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class CameraRig {
  mode: CamMode = 'chase';
  private q = new THREE.Quaternion();
  private initialized = false;
  private shake = 0;
  shakeEnabled = true;
  baseFov = 70;
  private orbitAngle = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  cycle() {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
  }

  /** pilot eye point and chase distance for the current airframe */
  readonly cockpit = new THREE.Vector3(0, 0.98, 0.32);
  chaseScale = 1;

  reset() {
    this.initialized = false;
  }

  addShake(a: number) {
    if (this.shakeEnabled) this.shake = Math.min(1.2, this.shake + a);
  }

  follow(
    dt: number,
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    speed: number,
    ground: (x: number, z: number) => number,
  ) {
    const cam = this.camera;
    if (!this.initialized) {
      this.q.copy(quat);
      this.initialized = true;
    }
    this.q.slerp(quat, 1 - Math.exp(-dt * 5));

    if (this.mode === 'cockpit') {
      _off.copy(this.cockpit).applyQuaternion(quat);
      cam.position.copy(pos).add(_off);
      cam.quaternion.copy(quat);
    } else {
      _off.set(0, 3.4 * this.chaseScale, 13.5 * this.chaseScale).applyQuaternion(this.q);
      cam.position.copy(pos).add(_off);
      _fwd.set(0, 0, -1).applyQuaternion(this.q);
      _look.copy(pos).addScaledVector(_fwd, 25);
      _up.set(0, 1, 0).applyQuaternion(this.q);
      _m.lookAt(cam.position, _look, _up);
      cam.quaternion.setFromRotationMatrix(_m);
    }

    // keep above the ground
    const g = Math.max(ground(cam.position.x, cam.position.z), 0) + 1.2;
    if (cam.position.y < g) cam.position.y = g;

    const fov = this.baseFov + THREE.MathUtils.clamp((speed - 30) / 45, 0, 1) * 10;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 3);
      cam.updateProjectionMatrix();
    }
    this.applyShake(dt);
  }

  orbit(dt: number, center: THREE.Vector3, radius: number, height: number, speed = 0.05) {
    this.orbitAngle += dt * speed;
    const cam = this.camera;
    cam.position.set(center.x + Math.cos(this.orbitAngle) * radius, center.y + height, center.z + Math.sin(this.orbitAngle) * radius);
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    this.applyShake(dt);
  }

  private applyShake(dt: number) {
    if (this.shake <= 0.001) return;
    const s = this.shake * this.shake * 0.6;
    this.camera.position.x += (Math.random() - 0.5) * s;
    this.camera.position.y += (Math.random() - 0.5) * s;
    this.camera.rotateZ((Math.random() - 0.5) * s * 0.02);
    this.shake = Math.max(0, this.shake - dt * 2.2);
  }
}
