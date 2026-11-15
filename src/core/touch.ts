import type { Insets } from './device';

/**
 * TouchControls (design §9.1): a floating stick under the left thumb, a throttle
 * lever on the right edge and round buttons (flaps ±, brake, camera, pause, bail).
 *
 * Split in two so it tests without a DOM:
 *  - pure: touchLayout(), hitTest(), stickCurve(), tiltAxes() and TouchModel,
 *    which turns pointer down / move / up (with timestamps) into a TouchState;
 *  - TouchControls: forwards Pointer Events and DeviceOrientation to the model.
 * Input.sample() reads the model and merges it into the normal ControlInput.
 */

export type ButtonId = 'pause' | 'camera' | 'bail' | 'flapsMore' | 'flapsLess' | 'brake';
export type Action = 'pause' | 'camera' | 'bail' | 'flapsMore' | 'flapsLess';
export type Control = ButtonId | 'lever' | 'stick';

export interface Circle {
  x: number;
  y: number;
  r: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TouchLayout {
  w: number;
  h: number;
  /** size unit: 1 on a 390 px tall phone, larger on tablets */
  u: number;
  safe: Insets;
  /** full-deflection drag distance of the stick (px) */
  stickR: number;
  /** where the stick is drawn while nobody touches it */
  stickRest: { x: number; y: number };
  /** touches starting here grab the stick */
  stickZone: Rect;
  lever: Rect;
  buttons: Record<ButtonId, Circle>;
  /** left / right edges of the thumbs' resting areas, for the HUD to keep gauges clear */
  leftEdge: number;
  rightEdge: number;
}

/** Minimap size and top on touch screens (the HUD uses the same numbers, the lever sits below). */
export const MINI_TOUCH = 104;
export const MINI_TOP = 46;

/** Hold BAIL this long to bail out. */
export const BAIL_HOLD = 1;
/** Two lever taps within this many seconds snap the throttle to idle. */
export const DOUBLE_TAP = 0.3;
const STICK_DEAD = 0.06;
/** extra touch slop around buttons and the lever (px at u = 1) */
const SLOP = 10;

export function touchLayout(w: number, h: number, safe: Insets): TouchLayout {
  const u = Math.max(0.85, Math.min(1.4, Math.min(w, h) / 390));
  const bottom = h - safe.b - 18 * u;
  // lever on the right edge, below the minimap
  const leverW = 46 * u;
  const leverX = w - safe.r - 14 * u - leverW;
  const leverTop = Math.max(safe.t + MINI_TOP + MINI_TOUCH + 14, h * 0.3);
  const lever: Rect = { x: leverX, y: leverTop, w: leverW, h: Math.max(90 * u, bottom - leverTop) };
  // button cluster left of the lever: BRAKE big at the bottom, flaps column left of it, camera and bail above
  const brakeR = 34 * u;
  const brake: Circle = { x: leverX - 16 * u - brakeR, y: bottom - brakeR, r: brakeR };
  const flapR = 26 * u;
  const flapX = brake.x - brakeR - 16 * u - flapR;
  const flapsMore: Circle = { x: flapX, y: bottom - flapR, r: flapR };
  const flapsLess: Circle = { x: flapX, y: flapsMore.y - 2 * flapR - 26 * u, r: flapR };
  const smallR = 23 * u;
  const camera: Circle = { x: brake.x, y: brake.y - brakeR - 14 * u - smallR, r: smallR };
  const bail: Circle = { x: brake.x, y: camera.y - 2 * smallR - 12 * u, r: smallR };
  const pause: Circle = { x: safe.l + 14 * u + 21 * u, y: safe.t + 12 * u + 21 * u, r: 21 * u };
  const stickR = 58 * u;
  const stickRest = { x: safe.l + 26 * u + stickR, y: bottom - stickR };
  const stickZone: Rect = { x: 0, y: pause.y + pause.r + 6 * u, w: Math.min(w * 0.5, flapX - flapR - 20 * u), h: h };
  return {
    w,
    h,
    u,
    safe,
    stickR,
    stickRest,
    stickZone,
    lever,
    buttons: { pause, camera, bail, flapsMore, flapsLess, brake },
    leftEdge: stickRest.x + stickR,
    rightEdge: flapX - flapR,
  };
}

const inCircle = (c: Circle, x: number, y: number, pad: number) => (x - c.x) ** 2 + (y - c.y) ** 2 <= (c.r + pad) ** 2;
const inRect = (r: Rect, x: number, y: number, pad: number) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;

/** Which control a touch at (x, y) grabs. BAIL only counts while it is shown. */
export function hitTest(l: TouchLayout, x: number, y: number, bailShown: boolean): Control | null {
  const pad = SLOP * l.u;
  // nearest button within reach wins, so neighbours with slop don't steal each other's taps
  let best: ButtonId | null = null;
  let bestD = Infinity;
  for (const id of Object.keys(l.buttons) as ButtonId[]) {
    if (id === 'bail' && !bailShown) continue;
    const c = l.buttons[id];
    if (!inCircle(c, x, y, pad)) continue;
    const d = Math.hypot(x - c.x, y - c.y) - c.r;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  if (best) return best;
  if (inRect(l.lever, x, y, pad)) return 'lever';
  if (inRect(l.stickZone, x, y, 0)) return 'stick';
  return null;
}

/** Stick response: dead zone, then a gentle expo so small corrections stay small. */
export function stickCurve(v: number): number {
  const a = Math.abs(v);
  if (a <= STICK_DEAD) return 0;
  const t = Math.min(1, (a - STICK_DEAD) / (1 - STICK_DEAD));
  return Math.sign(v) * Math.pow(t, 1.4);
}

/** Throttle 0..1 from a y position on the lever (top = full). */
export function leverThrottle(l: Rect, y: number): number {
  return Math.max(0, Math.min(1, (l.y + l.h - y) / l.h));
}

/**
 * Device tilt in screen space from DeviceOrientation β / γ (degrees) and the
 * screen orientation angle (0, 90, 180, 270 — 90 = device turned counter-clockwise).
 * roll: sideways tilt (rad, + = right edge down); pitch: how far the screen leans back (rad).
 */
export function tiltAngles(beta: number, gamma: number, screenAngle: number): { roll: number; pitch: number } {
  const b = (beta * Math.PI) / 180;
  const g = (gamma * Math.PI) / 180;
  // world "up" in device axes (x right, y top, z out of the screen)
  const ux = -Math.cos(b) * Math.sin(g);
  const uy = Math.sin(b);
  const uz = Math.cos(b) * Math.cos(g);
  const a = (screenAngle * Math.PI) / 180;
  const sx = ux * Math.cos(a) - uy * Math.sin(a);
  const sy = ux * Math.sin(a) + uy * Math.cos(a);
  return { roll: Math.asin(Math.max(-1, Math.min(1, -sx))), pitch: Math.atan2(uz, sy) };
}

/** Stick-like axes from tilt relative to the neutral attitude: ±25° = full, 3° dead zone. */
export function tiltAxes(now: { roll: number; pitch: number }, neutral: { roll: number; pitch: number }): { x: number; y: number } {
  const full = (25 * Math.PI) / 180;
  const dead = (3 * Math.PI) / 180;
  const axis = (d: number) => {
    const a = Math.abs(d);
    if (a <= dead) return 0;
    return Math.sign(d) * Math.min(1, (a - dead) / (full - dead));
  };
  let dp = now.pitch - neutral.pitch;
  if (dp > Math.PI) dp -= 2 * Math.PI;
  if (dp < -Math.PI) dp += 2 * Math.PI;
  // leaning the top edge away (screen faces up more) = push = nose down
  return { x: axis(now.roll - neutral.roll), y: 0 - axis(dp) };
}

interface Ptr {
  ctl: Control;
  x0: number;
  y0: number;
  x: number;
  y: number;
  t0: number;
}

/** Pure touch state: feed it pointer events, read the controls. */
export class TouchModel {
  layout: TouchLayout;
  /** set by the game each frame: BAIL is only there once airborne after take-off */
  bailShown = false;
  /** throttle lever position (0..1); kept in step with the keyboard while untouched */
  throttle = 0;
  private ptrs = new Map<number, Ptr>();
  private actions = new Set<Action>();
  private lastLeverTap = -1;
  private bailFired = false;

  constructor(w = 844, h = 390, safe: Insets = { l: 0, r: 0, t: 0, b: 0 }) {
    this.layout = touchLayout(w, h, safe);
  }

  resize(w: number, h: number, safe: Insets) {
    this.layout = touchLayout(w, h, safe);
  }

  down(id: number, x: number, y: number, t: number): Control | null {
    const ctl = hitTest(this.layout, x, y, this.bailShown);
    if (!ctl) return null;
    if (ctl === 'stick' && this.find('stick')) return null; // one stick thumb at a time
    this.ptrs.set(id, { ctl, x0: x, y0: y, x, y, t0: t });
    if (ctl === 'lever') {
      if (t - this.lastLeverTap < DOUBLE_TAP) {
        this.throttle = 0;
        this.lastLeverTap = -1;
        this.ptrs.get(id)!.y0 = NaN; // snapped: ignore drags until released
      } else {
        this.lastLeverTap = t;
        this.throttle = leverThrottle(this.layout.lever, y);
      }
    } else if (ctl === 'pause' || ctl === 'camera' || ctl === 'flapsMore' || ctl === 'flapsLess') {
      this.actions.add(ctl);
    } else if (ctl === 'bail') {
      this.bailFired = false;
    }
    return ctl;
  }

  move(id: number, x: number, y: number) {
    const p = this.ptrs.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    if (p.ctl === 'lever' && !Number.isNaN(p.y0)) this.throttle = leverThrottle(this.layout.lever, y);
  }

  up(id: number) {
    this.ptrs.delete(id);
  }

  /** Drop every touch (pause, screen change, pointercancel storms). */
  cancelAll() {
    this.ptrs.clear();
    this.bailFired = false;
  }

  /** Advance hold timers; call once per frame. */
  update(t: number) {
    const b = this.find('bail');
    if (b && this.bailShown && !this.bailFired && t - b.t0 >= BAIL_HOLD) {
      this.bailFired = true;
      this.actions.add('bail');
    }
  }

  /** Edge-triggered button presses since the last call. */
  take(): Set<Action> {
    const out = new Set(this.actions);
    this.actions.clear();
    return out;
  }

  get active(): boolean {
    return this.ptrs.size > 0;
  }

  get leverHeld(): boolean {
    return !!this.find('lever');
  }

  get brake(): boolean {
    return !!this.find('brake');
  }

  held(id: Control): boolean {
    return !!this.find(id);
  }

  /** BAIL hold progress 0..1 (0 when not held). */
  bailProgress(t: number): number {
    const b = this.find('bail');
    return b && this.bailShown ? Math.min(1, (t - b.t0) / BAIL_HOLD) : 0;
  }

  /** Stick origin, knob position and raw deflection (x right, y down = pull up), or null. */
  stick(): { ox: number; oy: number; x: number; y: number } | null {
    const p = this.find('stick');
    if (!p) return null;
    const R = this.layout.stickR;
    let dx = (p.x - p.x0) / R;
    let dy = (p.y - p.y0) / R;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    return { ox: p.x0, oy: p.y0, x: dx, y: dy };
  }

  private find(ctl: Control): Ptr | undefined {
    for (const p of this.ptrs.values()) if (p.ctl === ctl) return p;
    return undefined;
  }
}

/** DOM side: Pointer Events on the game canvas and (optional) DeviceOrientation tilt. */
export class TouchControls {
  readonly model = new TouchModel();
  /** set by the game: true while a sortie is flying and not paused */
  enabled = false;
  /** a touch landed on the canvas (switches the HUD and hints to touch) */
  onTouch: (() => void) | null = null;
  private tiltOn = false;
  private tiltNow: { roll: number; pitch: number } | null = null;
  private tiltSmooth: { roll: number; pitch: number } | null = null;
  private neutral: { roll: number; pitch: number } | null = null;

  constructor(target: HTMLElement) {
    const now = () => performance.now() / 1000;
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      this.onTouch?.();
      if (!this.enabled) return;
      if (this.model.down(e.pointerId, e.clientX, e.clientY, now())) {
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        e.preventDefault();
      }
    });
    target.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') this.model.move(e.pointerId, e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerType === 'touch') this.model.up(e.pointerId);
    };
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    target.addEventListener('lostpointercapture', end);
    // no long-press menu / magnifier over the game
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setEnabled(on: boolean) {
    if (this.enabled && !on) this.model.cancelAll();
    this.enabled = on;
  }

  // ------------------------------------------------------------- tilt

  get tiltEnabled(): boolean {
    return this.tiltOn;
  }

  /** True when the browser offers device orientation at all. */
  static tiltSupported(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /**
   * Turn tilt steering on or off. On iOS the permission prompt needs a user gesture,
   * so call this from the toggle's tap. Resolves false if it can't be used.
   */
  async setTilt(on: boolean): Promise<boolean> {
    if (!on) {
      this.tiltOn = false;
      window.removeEventListener('deviceorientation', this.onOrient);
      this.tiltNow = this.tiltSmooth = null;
      return true;
    }
    if (!TouchControls.tiltSupported()) return false;
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> };
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    this.tiltOn = true;
    this.neutral = null;
    window.addEventListener('deviceorientation', this.onOrient);
    return true;
  }

  /** Use the current attitude as neutral (sortie start, 'Re-centre'). */
  recentre() {
    this.neutral = this.tiltSmooth ? { ...this.tiltSmooth } : null;
  }

  /** Tilt as stick axes, or null when off / no data yet. */
  tilt(): { x: number; y: number } | null {
    if (!this.tiltOn || !this.tiltSmooth) return null;
    if (!this.neutral) this.neutral = { ...this.tiltSmooth };
    return tiltAxes(this.tiltSmooth, this.neutral);
  }

  /** Low-pass filter step; call once per frame. */
  update(dt: number) {
    this.model.update(performance.now() / 1000);
    if (!this.tiltNow) return;
    if (!this.tiltSmooth) this.tiltSmooth = { ...this.tiltNow };
    const k = 1 - Math.exp(-dt * 12);
    this.tiltSmooth.roll += (this.tiltNow.roll - this.tiltSmooth.roll) * k;
    let dp = this.tiltNow.pitch - this.tiltSmooth.pitch;
    if (dp > Math.PI) dp -= 2 * Math.PI;
    if (dp < -Math.PI) dp += 2 * Math.PI;
    this.tiltSmooth.pitch += dp * k;
  }

  private onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    const angle = screen.orientation?.angle ?? ((window as unknown as { orientation?: number }).orientation ?? 0);
    this.tiltNow = tiltAngles(e.beta, e.gamma, ((angle % 360) + 360) % 360);
  };
}
