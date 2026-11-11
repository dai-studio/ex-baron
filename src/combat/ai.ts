import * as THREE from 'three';
import type { Plane } from '../plane/plane';
import { steerToward } from '../plane/steer';
import { BULLET_SPEED } from './weapons';
import type { Difficulty } from '../core/settings';

/**
 * Enemy AI pilots (design §3): same flight model as the player; state
 * machine Patrol → Engage → Attack (lead pursuit) → Evade → Disengage;
 * PD steering; terrain avoidance with look-ahead height samples.
 */
export interface Skill {
  name: Difficulty;
  aimErr: number;
  react: number;
  fireCone: number;
  fireRange: number;
  evadeChance: number;
  pull: number;
}

export const SKILLS: Record<Difficulty, Skill> = {
  rookie: { name: 'rookie', aimErr: 0.07, react: 0.6, fireCone: 0.075, fireRange: 380, evadeChance: 0.25, pull: 0.72 },
  veteran: { name: 'veteran', aimErr: 0.04, react: 0.35, fireCone: 0.055, fireRange: 450, evadeChance: 0.55, pull: 0.86 },
  ace: { name: 'ace', aimErr: 0.022, react: 0.2, fireCone: 0.045, fireRange: 520, evadeChance: 0.85, pull: 1 },
};

export type AIState = 'patrol' | 'engage' | 'attack' | 'evade' | 'disengage';

const _to = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tf = new THREE.Vector3();

export class AIPilot {
  state: AIState = 'engage';
  private thinkT = 0;
  private desired = new THREE.Vector3(0, 0, -1);
  private evadeT = 0;
  private evadeSide = 1;
  private noise = new THREE.Vector3();
  private fire = false;
  private throttle = 1;
  private patrolCenter = new THREE.Vector3();
  private patrolAngle = 0;

  constructor(
    readonly skill: Skill,
    private rnd: () => number,
  ) {}

  setPatrol(center: THREE.Vector3) {
    this.patrolCenter.copy(center);
    this.state = 'patrol';
  }

  update(dt: number, self: Plane, target: Plane | null, mates: Plane[], ground: (x: number, z: number) => number) {
    const s = self.s;
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = this.skill.react * (0.7 + this.rnd() * 0.6);
      this.think(self, target, mates, ground);
    }
    const agl = s.pos.y - Math.max(ground(s.pos.x, s.pos.z), 0);
    const maxBank = agl < 120 ? 0.7 : agl < 250 ? 1.1 : Math.PI;
    steerToward(s, self.spec, this.desired, self.input, this.skill.pull, maxBank);
    self.input.throttle = this.throttle;
    self.input.fire = this.fire && this.checkFire(self, target);
    self.input.brake = false;
  }

  private checkFire(self: Plane, target: Plane | null) {
    if (!target || !target.alive) return false;
    self.forward(_fwd);
    _to.copy(target.s.pos).sub(self.s.pos);
    const dist = _to.length();
    if (dist > this.skill.fireRange) return false;
    const tof = dist / BULLET_SPEED;
    _aim.copy(target.s.pos).addScaledVector(target.s.vel, tof).sub(self.s.pos).normalize();
    return _fwd.dot(_aim) > Math.cos(this.skill.fireCone);
  }

  private think(self: Plane, target: Plane | null, mates: Plane[], ground: (x: number, z: number) => number) {
    const s = self.s;
    self.forward(_fwd);
    _right.set(1, 0, 0).applyQuaternion(s.quat);
    this.fire = false;
    this.throttle = 1;
    const health = self.integrity;

    if (target && target.alive) {
      _to.copy(target.s.pos).sub(s.pos);
      const dist = _to.length();
      if (this.state === 'patrol' && dist < 2200) this.state = 'engage';
      if (health < 0.3 && this.state !== 'disengage' && this.rnd() < 0.5) this.state = 'disengage';
      if (this.state === 'engage' && dist < 900) this.state = 'attack';
      if (this.state === 'attack' && dist > 1400) this.state = 'engage';

      // threat behind us? maybe break
      if (this.state === 'attack' || this.state === 'engage') {
        target.forward(_tf);
        const fromTarget = _p.copy(s.pos).sub(target.s.pos);
        const dT = fromTarget.length();
        const onTail = dT < 420 && _tf.dot(fromTarget.normalize()) > 0.93 && _fwd.dot(_tf) > 0.3;
        if (onTail && this.evadeT <= 0 && this.rnd() < this.skill.evadeChance) {
          this.state = 'evade';
          this.evadeT = 1.8 + this.rnd() * 2;
          this.evadeSide = this.rnd() < 0.5 ? -1 : 1;
        }
      }
    } else if (this.state !== 'patrol') {
      this.state = 'patrol';
      this.patrolCenter.copy(s.pos);
    }

    switch (this.state) {
      case 'patrol': {
        this.patrolAngle += 0.25 * this.skill.react;
        _p.set(
          this.patrolCenter.x + Math.cos(this.patrolAngle) * 700,
          Math.max(this.patrolCenter.y, ground(s.pos.x, s.pos.z) + 300),
          this.patrolCenter.z + Math.sin(this.patrolAngle) * 700,
        );
        this.desired.copy(_p).sub(s.pos).normalize();
        this.throttle = 0.75;
        break;
      }
      case 'engage':
      case 'attack': {
        if (!target) break;
        const dist = _to.length();
        const tof = dist / BULLET_SPEED;
        if (this.rnd() < 0.5) this.noise.set(this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5).multiplyScalar(this.skill.aimErr * 2);
        _aim.copy(target.s.pos).addScaledVector(target.s.vel, this.state === 'attack' ? tof : 0).sub(s.pos).normalize().add(this.noise);
        this.desired.copy(_aim).normalize();
        this.fire = this.state === 'attack';
        // don't overshoot: ease off when close and fast-closing
        const closing = _p.copy(s.vel).sub(target.s.vel).dot(_to.clone().normalize());
        if (dist < 160 && closing > 12) this.throttle = 0.4;
        break;
      }
      case 'evade': {
        this.evadeT -= this.skill.react;
        this.desired.copy(_right).multiplyScalar(this.evadeSide).addScaledVector(_fwd, 0.25);
        this.desired.y -= 0.35;
        this.desired.normalize();
        if (this.evadeT <= 0) this.state = 'engage';
        break;
      }
      case 'disengage': {
        if (target) this.desired.copy(s.pos).sub(target.s.pos).setY(0).normalize();
        this.desired.y = -0.1;
        this.desired.normalize();
        break;
      }
    }

    // energy & altitude: dive to regain speed when slow, drift back up to fighting height
    const aglNow = s.pos.y - Math.max(ground(s.pos.x, s.pos.z), 0);
    if (s.airspeed < 27 && aglNow > 120) {
      this.desired.y = Math.min(this.desired.y, -0.25);
      this.desired.normalize();
    } else if (aglNow < 260 && this.state !== 'evade' && s.airspeed > 32) {
      this.desired.y = Math.max(this.desired.y, 0.12);
      this.desired.normalize();
    }

    // keep away from wingmen
    for (const m of mates) {
      if (m === self || !m.alive) continue;
      _p.copy(s.pos).sub(m.s.pos);
      const d = _p.length();
      if (d < 70 && d > 0.1) this.desired.addScaledVector(_p.divideScalar(d), (70 - d) / 70).normalize();
    }

    // terrain avoidance: look ahead along the velocity
    let minClear = Infinity;
    for (const t of [1, 2.5, 4.5, 7]) {
      _p.copy(s.pos).addScaledVector(s.vel, t);
      const g = Math.max(ground(_p.x, _p.z), 0);
      minClear = Math.min(minClear, _p.y - g);
    }
    const agl = s.pos.y - Math.max(ground(s.pos.x, s.pos.z), 0);
    if (minClear < 130 || agl < 90) {
      const urgency = THREE.MathUtils.clamp((130 - Math.min(minClear, agl)) / 70, 0, 1);
      if (urgency > 0.3) {
        // also turn toward the lowest ground ahead (out of rising valleys)
        const sp = Math.max(Math.hypot(s.vel.x, s.vel.z), 10);
        const hx = s.vel.x / sp;
        const hz = s.vel.z / sp;
        let bestH = Infinity;
        let bx = hx;
        let bz = hz;
        for (const a of [-0.9, -0.45, 0, 0.45, 0.9]) {
          const c = Math.cos(a);
          const sn = Math.sin(a);
          const dx = hx * c - hz * sn;
          const dz = hx * sn + hz * c;
          let h = 0;
          for (const d of [120, 220]) h = Math.max(h, ground(s.pos.x + dx * d, s.pos.z + dz * d));
          if (h < bestH - 5) {
            bestH = h;
            bx = dx;
            bz = dz;
          }
        }
        this.desired.set(bx, 0, bz);
      }
      this.desired.y = Math.max(this.desired.y, 0.25 + 0.5 * urgency);
      this.desired.normalize();
      this.throttle = 1;
      if (urgency > 0.6) this.fire = false;
    }
  }
}
