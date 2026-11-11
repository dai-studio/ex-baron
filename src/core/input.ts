import type { ControlInput } from '../plane/flight';

/**
 * Controls & input (design §3): keyboard, mouse "virtual stick" and gamepad
 * mapped to a normalised ControlInput. Assists are applied later by the game.
 */
const AXIS_RATE = 4.5; // keyboard axes ramp instead of snapping
const THROTTLE_RATE = 0.6;

export class Input {
  readonly keys = new Set<string>();
  private pressed = new Set<string>();
  mouse = { x: 0, y: 0, down: false };
  mouseStick = false;
  throttle = 0;
  invertPitch = false;
  private axes = { pitch: 0, roll: 0, yaw: 0 };
  private padPressed = new Set<number>();
  private padPrev: boolean[] = [];
  /** true while any keyboard/pad flight input is active this frame */
  manual = false;

  constructor(private target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.down = false;
    });
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -((e.clientY / window.innerHeight) * 2 - 1);
    });
    this.target.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouse.down = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
    });
  }

  /** Edge-triggered key check; cleared by endFrame(). */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }
  padWasPressed(button: number): boolean {
    return this.padPressed.has(button);
  }

  endFrame() {
    this.pressed.clear();
    this.padPressed.clear();
  }

  private gamepad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** Poll gamepad buttons once per frame for edge detection. */
  pollPad() {
    const pad = this.gamepad();
    if (!pad) return;
    pad.buttons.forEach((b, i) => {
      if (b.pressed && !this.padPrev[i]) this.padPressed.add(i);
      this.padPrev[i] = b.pressed;
    });
  }

  resetThrottle(v = 0) {
    this.throttle = v;
  }

  sample(dt: number, out: ControlInput) {
    const k = this.keys;
    const kPitch = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    const kRoll = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const kYaw = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    const ramp = (cur: number, target: number) => {
      const step = AXIS_RATE * dt;
      if (target === 0) return Math.abs(cur) <= step * 1.5 ? 0 : cur - Math.sign(cur) * step * 1.5;
      return cur + Math.max(-step, Math.min(step, target - cur));
    };
    this.axes.pitch = ramp(this.axes.pitch, kPitch);
    this.axes.roll = ramp(this.axes.roll, kRoll);
    this.axes.yaw = ramp(this.axes.yaw, kYaw);

    let pitch = this.axes.pitch;
    let roll = this.axes.roll;
    let yaw = this.axes.yaw;
    let fire = k.has('Space');
    let brake = k.has('KeyB');

    // throttle
    if (k.has('ShiftLeft') || k.has('ShiftRight')) this.throttle += THROTTLE_RATE * dt;
    if (k.has('ControlLeft') || k.has('ControlRight')) this.throttle -= THROTTLE_RATE * dt;
    for (let d = 1; d <= 9; d++) if (k.has(`Digit${d}`)) this.throttle = d / 10;
    if (k.has('Digit0')) this.throttle = 1;

    // gamepad (standard mapping)
    const pad = this.gamepad();
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const lx = dz(pad.axes[0] ?? 0);
      const ly = dz(pad.axes[1] ?? 0);
      const rx = dz(pad.axes[2] ?? 0);
      const ry = dz(pad.axes[3] ?? 0);
      if (lx || ly) {
        roll = lx;
        pitch = ly; // stick back (positive y) = pull up
      }
      if (rx) yaw = rx;
      if (ry) this.throttle -= ry * THROTTLE_RATE * 1.5 * dt;
      if ((pad.buttons[7]?.value ?? 0) > 0.3 || pad.buttons[0]?.pressed) fire = true;
      if (pad.buttons[1]?.pressed) brake = true;
    }

    this.manual = pitch !== 0 || roll !== 0 || yaw !== 0;

    // mouse virtual stick: cursor offset from centre = stick deflection
    if (this.mouseStick && !this.manual) {
      const dz = (v: number) => (Math.abs(v) < 0.05 ? 0 : Math.max(-1, Math.min(1, (v - Math.sign(v) * 0.05) * 2.2)));
      roll = dz(this.mouse.x);
      pitch = dz(this.mouse.y); // cursor above centre = nose up
    }
    if (this.mouseStick && this.mouse.down) fire = true;

    if (this.invertPitch) pitch = -pitch;

    this.throttle = Math.max(0, Math.min(1, this.throttle));
    out.pitch = Math.max(-1, Math.min(1, pitch));
    out.roll = Math.max(-1, Math.min(1, roll));
    out.yaw = Math.max(-1, Math.min(1, yaw));
    out.throttle = this.throttle;
    out.fire = fire;
    out.brake = brake;
  }
}
