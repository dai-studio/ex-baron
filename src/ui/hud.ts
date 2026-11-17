import * as THREE from 'three';
import type { Plane } from '../plane/plane';
import { FLAP_LABELS, FLAP_NOTCHES, LANDING_FORGIVENESS } from '../plane/flight';
import { engineOf } from '../plane/loadout';
import type { World } from '../world/world';
import type { Route } from '../game/route';
import type { Airfield } from '../world/terrain';
import { CLUSTER_H, CLUSTER_W, Instruments } from './instruments';
import { altOf, altUnit, fmtVs, speedOf, speedUnit, vsUnit, vsValue } from '../core/units';
import { MINI_TOP, MINI_TOUCH, type Circle, type Control, type TouchLayout } from '../core/touch';

/**
 * HUD & UI (design §3): hand-drawn style overlay on a 2D canvas —
 * airspeed, altitude, throttle, compass ribbon, damage silhouette,
 * minimap, mouse-stick cursor and a landing guide.
 */
const INK = '#2b1d1a';
const PAPER = '#fff6dd';
const ACCENT = '#2a9d8f';
const GOLD = '#f2b134';
const RED = '#e04f3a';
const FONT = '"Baloo 2", "Trebuchet MS", sans-serif';

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();

export interface HudContext {
  player: Plane;
  world: World;
  camera: THREE.PerspectiveCamera;
  objective: string;
  mouseStick: boolean;
  mouse: { x: number; y: number };
  stallWarn: boolean;
  showLanding: boolean;
  /** flap lever notch (index into FLAP_NOTCHES) */
  flapNotch: number;
  /** cross-country flight: the route, destination and (when off the path) where to rejoin it */
  guide?: { route: Route; dest: Airfield; rejoin: THREE.Vector3 | null };
  /** touch play: draw the on-screen controls and keep the gauges clear of the thumbs (design §9.2) */
  touch?: TouchView | null;
}

export interface TouchView {
  layout: TouchLayout;
  stick: { ox: number; oy: number; x: number; y: number } | null;
  throttle: number;
  held(id: Control): boolean;
  bailShown: boolean;
  bailProgress: number;
  tilt: boolean;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function panel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.fillStyle = INK;
  roundRect(g, x + 4, y + 4, w, h, 12);
  g.fill();
  g.fillStyle = PAPER;
  roundRect(g, x, y, w, h, 12);
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.stroke();
}

export class Hud {
  private g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private mini: HTMLCanvasElement;
  private miniAt = new THREE.Vector2(1e9, 1e9);
  private miniT = 0;
  private readonly miniSpan = 7000;
  private instruments = new Instruments();
  /** top and centre of the instrument cluster (CSS px), so the landing guide sits above it */
  private clusterTop = 0;
  private clusterCx = 0;
  visible = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!;
    this.mini = document.createElement('canvas');
    this.mini.width = this.mini.height = 96;
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
  }

  clear() {
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  invalidateMinimap() {
    this.miniAt.set(1e9, 1e9);
  }

  private project(p: THREE.Vector3, cam: THREE.PerspectiveCamera): { x: number; y: number; behind: boolean } {
    _v.copy(p).project(cam);
    const behind = _v.z > 1;
    return { x: ((_v.x + 1) / 2) * this.w, y: ((1 - _v.y) / 2) * this.h, behind };
  }

  draw(c: HudContext, dt: number) {
    this.clear();
    if (!this.visible) return;
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const s = c.player.s;
    const compact = this.w < 800; // narrow desktop: smaller side panels so the four-gauge cluster fits between them
    const sc = compact ? 0.8 : 1;

    const tv = c.touch ?? null;
    const cl = this.cluster(sc, tv);
    this.clusterTop = cl.y;
    this.clusterCx = cl.cx;

    // ---------- markers in the world
    if (!tv) this.drawMouseStick(c);
    if (c.showLanding) this.drawLandingGuide(c);
    if (c.guide?.rejoin) this.drawRejoin(c.guide.rejoin, c.camera);

    if (tv) {
      // no instrument cluster on touch: on a phone it filled half the screen and hid the plane;
      // speed and altitude are in the status card instead
      this.drawTouchStatus(c, tv);
      this.drawCompass(c, Math.min(300, this.w * 0.36), tv.layout.safe.t);
      this.drawObjective(c.objective, 14, tv.layout.safe.t);
      this.miniT -= dt;
      this.drawMinimap(c, MINI_TOUCH, tv.layout.safe.t, tv.layout.safe.r);
      this.drawTouchControls(c, tv);
      return;
    }

    // ---------- bottom-left gauges
    g.save();
    g.translate(16, this.h - 16 - 218 * sc);
    g.scale(sc, sc);
    panel(g, 0, 0, 220, 218);
    const spd = speedOf(s.airspeed);
    const agl = s.pos.y - Math.max(c.world.groundHeight(s.pos.x, s.pos.z), 0);
    g.fillStyle = INK;
    g.font = `800 14px ${FONT}`;
    g.fillText('SPEED', 14, 24);
    g.fillText('ALT', 120, 24);
    g.font = `800 30px ${FONT}`;
    g.fillStyle = c.stallWarn ? RED : INK;
    const spdStr = `${Math.round(spd)}`;
    g.fillText(spdStr, 14, 56);
    const kw = g.measureText(spdStr).width;
    g.fillStyle = INK;
    g.fillText(`${Math.round(altOf(s.pos.y))}`, 120, 56);
    g.font = `700 13px ${FONT}`;
    g.fillText(speedUnit(), 14 + kw + 4, 56);
    g.fillText(`${altUnit()}  (${Math.round(altOf(agl))} AGL)`, 120, 74);
    if (c.stallWarn) {
      g.fillStyle = RED;
      g.font = `800 15px ${FONT}`;
      g.fillText('STALL!', 14, 76);
    }
    // throttle bar
    g.font = `800 13px ${FONT}`;
    g.fillStyle = INK;
    g.fillText('THROTTLE', 14, 102);
    roundRect(g, 14, 108, 192, 16, 8);
    g.fillStyle = '#fff';
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 2.5;
    g.stroke();
    roundRect(g, 16, 110, Math.max(6, 188 * s.throttle), 12, 6);
    g.fillStyle = GOLD;
    g.fill();
    g.fillStyle = INK;
    g.font = `700 12px ${FONT}`;
    const eng = engineOf(c.player.loadout.style);
    const turn = eng === 'jet' ? `spool ${Math.round(s.rpm * 100)}%` : `rpm ${Math.round(s.rpm * (eng === 'turbo' ? 2000 : 1400))}`;
    g.fillText(`${Math.round(s.throttle * 100)}%   ${turn}`, 16, 142);
    this.drawFlaps(g, c.flapNotch, s.flaps, s.flapsBlown);
    g.restore();

    // ---------- bottom-right: damage
    g.save();
    g.translate(this.w - 16 - 120 * sc, this.h - 16 - 150 * sc);
    g.scale(sc, sc);
    panel(g, 0, 0, 120, 150);
    g.fillStyle = INK;
    g.font = `800 14px ${FONT}`;
    g.fillText('DAMAGE', 14, 24);
    this.drawDamage(g, 60, 92, s.health);
    g.restore();

    // ---------- bottom-centre: airspeed, attitude, altimeter, vertical speed
    this.drawInstruments(c, cl);

    // ---------- top: compass ribbon + objective
    this.drawCompass(c, Math.min(420, this.w - 40), 0);
    this.drawObjective(c.objective, compact ? 14 : 16, 0);

    // ---------- minimap (top-right)
    this.miniT -= dt;
    this.drawMinimap(c, compact ? 120 : 160, 0, 0);
  }

  private drawObjective(text: string, size: number, top: number) {
    const g = this.g;
    g.font = `800 ${size}px ${FONT}`;
    g.textAlign = 'center';
    const objW = g.measureText(text).width + 28;
    panel(g, this.w / 2 - objW / 2, top + 62, objW, 30);
    g.fillStyle = INK;
    g.fillText(text, this.w / 2, top + 62 + 21);
    g.textAlign = 'left';
  }

  /**
   * Where the instrument cluster goes. Desktop: centre-bottom between the gauge panel (left) and
   * the damage panel (right). Touch: in the gap between the stick thumb and the button cluster.
   */
  private cluster(sc: number, tv: TouchView | null): { k: number; cx: number; y: number } {
    if (tv) {
      // touch draws no cluster: the landing guide sits low, between the thumbs
      const l = tv.layout;
      return { k: 0, cx: (l.leftEdge + l.rightEdge) / 2, y: this.h - l.safe.b - 12 };
    }
    const side = Math.max(16 + 220 * sc, 16 + 120 * sc) + 12;
    const k = THREE.MathUtils.clamp((this.w - 2 * side) / CLUSTER_W, 0.35, 1);
    return { k, cx: this.w / 2, y: this.h - 16 - CLUSTER_H * k };
  }

  private drawInstruments(c: HudContext, cl: { k: number; cx: number; y: number }) {
    const g = this.g;
    const p = c.player;
    p.forward(_fwd);
    p.up(_up);
    _right.set(1, 0, 0).applyQuaternion(p.s.quat);
    const pitch = Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1));
    const bank = Math.atan2(-_right.y, _up.y);
    const k = cl.k;
    g.save();
    g.translate(cl.cx - (CLUSTER_W * k) / 2, cl.y);
    g.scale(k, k);
    this.instruments.draw(g, 0, 0, k * this.dpr, { airspeed: p.s.airspeed, altitude: p.s.pos.y, vs: p.s.vel.y, pitch, bank, spec: p.spec });
    g.restore();
  }

  /** FLAPS row: the three notches (lever highlighted), a bar for the actual position, a warning when blown back. */
  private drawFlaps(g: CanvasRenderingContext2D, notch: number, pos: number, blown: boolean) {
    // a dashed divider keeps the flaps apart from the throttle / rpm line above
    g.save();
    g.strokeStyle = 'rgba(43, 29, 26, 0.35)';
    g.lineWidth = 1.5;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(14, 156);
    g.lineTo(206, 156);
    g.stroke();
    g.restore();
    const y = 176;
    g.font = `800 13px ${FONT}`;
    g.fillStyle = blown ? RED : INK;
    g.fillText('FLAPS', 14, y);
    const lw = g.measureText('FLAPS').width;
    // keys: V moves the lever left (less flap), F right (more), matching the UP → LAND row below
    g.font = `700 12px ${FONT}`;
    g.fillStyle = blown ? RED : '#6b4b2a';
    g.fillText(blown ? 'TOO FAST — slow down!' : '(V ↔ F)', 14 + lw + 6, y);
    const x0 = 14;
    const w = 60;
    for (let i = 0; i < FLAP_NOTCHES.length; i++) {
      const x = x0 + i * (w + 6);
      roundRect(g, x, y + 6, w, 18, 7);
      g.fillStyle = i === notch ? (blown ? RED : ACCENT) : '#fff';
      g.fill();
      g.strokeStyle = INK;
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = i === notch ? '#fff' : INK;
      g.font = `800 11px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(FLAP_LABELS[i], x + w / 2, y + 19);
      g.textAlign = 'left';
    }
    // actual flap position (moves slowly, blown back when too fast)
    const span = 2 * (w + 6);
    g.fillStyle = INK;
    g.beginPath();
    const px = x0 + w / 2 + pos * span;
    g.moveTo(px, y + 26);
    g.lineTo(px - 5, y + 31);
    g.lineTo(px + 5, y + 31);
    g.closePath();
    g.fill();
  }

  private drawDamage(g: CanvasRenderingContext2D, cx: number, cy: number, h: { engine: number; wings: number; tail: number; pilot: number }) {
    const col = (v: number) => (v > 0.7 ? '#7cc95a' : v > 0.4 ? '#f2b134' : v > 0 ? '#e0703a' : '#6b2a22');
    g.save();
    g.translate(cx, cy);
    g.lineWidth = 2.5;
    g.strokeStyle = INK;
    // wings
    g.fillStyle = col(h.wings);
    roundRect(g, -44, -22, 88, 16, 6);
    g.fill();
    g.stroke();
    // fuselage
    g.fillStyle = col(Math.min(h.pilot, 1));
    roundRect(g, -8, -34, 16, 62, 6);
    g.fill();
    g.stroke();
    // engine
    g.fillStyle = col(h.engine);
    g.beginPath();
    g.arc(0, -36, 10, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    // tail
    g.fillStyle = col(h.tail);
    roundRect(g, -20, 24, 40, 10, 4);
    g.fill();
    g.stroke();
    g.restore();
  }

  private drawCompass(c: HudContext, w: number, top: number) {
    const g = this.g;
    const x0 = this.w / 2 - w / 2;
    const y0 = top + 12;
    panel(g, x0, y0, w, 40);
    c.player.forward(_fwd);
    const heading = (Math.atan2(_fwd.x, -_fwd.z) * 180) / Math.PI;
    g.save();
    roundRect(g, x0 + 3, y0 + 3, w - 6, 34, 10);
    g.clip();
    const pxPerDeg = w / 120;
    g.fillStyle = INK;
    g.strokeStyle = INK;
    g.textAlign = 'center';
    for (let d = Math.floor((heading - 70) / 15) * 15; d <= heading + 70; d += 15) {
      const x = this.w / 2 + (d - heading) * pxPerDeg;
      const dd = ((d % 360) + 360) % 360;
      const label = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : dd % 45 === 0 ? String(dd) : '';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y0 + 30);
      g.lineTo(x, y0 + (label ? 24 : 27));
      g.stroke();
      if (label) {
        g.font = `800 ${label.length === 1 ? 16 : 12}px ${FONT}`;
        g.fillText(label, x, y0 + 20);
      }
    }
    // objective + home markers on the ribbon
    const mark = (p: THREE.Vector3, color: string) => {
      const b = (Math.atan2(p.x - c.player.s.pos.x, -(p.z - c.player.s.pos.z)) * 180) / Math.PI;
      let rel = b - heading;
      rel = ((rel + 540) % 360) - 180;
      const x = this.w / 2 + THREE.MathUtils.clamp(rel, -58, 58) * pxPerDeg;
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(x, y0 + 36);
      g.lineTo(x - 6, y0 + 28);
      g.lineTo(x + 6, y0 + 28);
      g.closePath();
      g.fill();
    };
    const near = c.world.gen.nearestAirfield(c.player.s.pos.x, c.player.s.pos.z).af;
    mark(new THREE.Vector3(near.x, 0, near.z), ACCENT);
    if (c.guide) mark(new THREE.Vector3(c.guide.dest.x, 0, c.guide.dest.z), GOLD);
    g.restore();
    // centre caret
    g.fillStyle = INK;
    g.beginPath();
    g.moveTo(this.w / 2, y0 + 38);
    g.lineTo(this.w / 2 - 7, y0 + 46);
    g.lineTo(this.w / 2 + 7, y0 + 46);
    g.closePath();
    g.fill();
    g.textAlign = 'left';
  }

  /** Off the path: a marker on the path ahead to fly back to (an edge arrow when off-screen). */
  private drawRejoin(p: THREE.Vector3, cam: THREE.PerspectiveCamera) {
    const g = this.g;
    _v.copy(p).applyMatrix4(cam.matrixWorldInverse);
    const behind = _v.z > 0;
    const q = this.project(p, cam);
    const m = 60;
    const onScreen = !behind && q.x > m && q.x < this.w - m && q.y > m && q.y < this.h - m;
    g.save();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.fillStyle = '#ffffff';
    if (onScreen) {
      g.beginPath();
      g.arc(q.x, q.y, 13, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      g.arc(q.x, q.y, 4, 0, Math.PI * 2);
      g.fillStyle = INK;
      g.fill();
      g.font = `800 13px ${FONT}`;
      g.textAlign = 'center';
      g.lineWidth = 4;
      g.strokeStyle = '#ffffff';
      g.strokeText('PATH', q.x, q.y - 20);
      g.fillText('PATH', q.x, q.y - 20);
    } else {
      // direction in screen space from the view-space position
      let dx = _v.x;
      let dy = -_v.y;
      if (behind && Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) dy = 1;
      const a = Math.atan2(dy, dx);
      const cx = this.w / 2;
      const cy = this.h / 2;
      const k = Math.min((this.w / 2 - m) / Math.abs(Math.cos(a) || 1e-6), (this.h / 2 - m) / Math.abs(Math.sin(a) || 1e-6));
      g.translate(cx + Math.cos(a) * k, cy + Math.sin(a) * k);
      g.rotate(a);
      g.beginPath();
      g.moveTo(18, 0);
      g.lineTo(-10, -13);
      g.lineTo(-4, 0);
      g.lineTo(-10, 13);
      g.closePath();
      g.fill();
      g.stroke();
    }
    g.restore();
  }

  private drawMouseStick(c: HudContext) {
    if (!c.mouseStick) return;
    const g = this.g;
    const mx = ((c.mouse.x + 1) / 2) * this.w;
    const my = ((1 - c.mouse.y) / 2) * this.h;
    g.strokeStyle = ACCENT;
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(mx, my, 8, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([4, 6]);
    g.beginPath();
    g.moveTo(this.w / 2, this.h / 2);
    g.lineTo(mx, my);
    g.stroke();
    g.setLineDash([]);
  }

  private drawLandingGuide(c: HudContext) {
    const g = this.g;
    const s = c.player.s;
    const { af, dist } = c.world.gen.nearestAirfield(s.pos.x, s.pos.z);
    if (dist > 2500) return;
    const cam = c.camera;
    // runway end markers
    const ends = [-1, 1].map((k) => new THREE.Vector3(af.x + af.dirX * (af.length / 2) * k, af.height + 1, af.z + af.dirZ * (af.length / 2) * k));
    const centre = new THREE.Vector3(af.x, af.height + 1, af.z);
    const pc = this.project(centre, cam);
    if (!pc.behind) {
      g.fillStyle = ACCENT;
      g.strokeStyle = INK;
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(pc.x, pc.y - 8);
      g.lineTo(pc.x - 10, pc.y - 26);
      g.lineTo(pc.x + 10, pc.y - 26);
      g.closePath();
      g.fill();
      g.stroke();
      g.font = `800 12px ${FONT}`;
      g.textAlign = 'center';
      g.fillStyle = INK;
      g.fillText('STRIP', pc.x, pc.y - 30);
      g.textAlign = 'left';
    }
    for (const e of ends) {
      const p = this.project(e, cam);
      if (p.behind) continue;
      g.fillStyle = PAPER;
      g.strokeStyle = INK;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(p.x, p.y, 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    // glide slope advice (≈4°) toward the nearer runway end
    const nearEnd = ends[0].distanceTo(s.pos) < ends[1].distanceTo(s.pos) ? ends[0] : ends[1];
    const horiz = Math.hypot(nearEnd.x - s.pos.x, nearEnd.z - s.pos.z);
    const ideal = af.height + horiz * Math.tan((4 * Math.PI) / 180);
    const diff = s.pos.y - ideal;
    if (horiz < 2200 && !s.onGround) {
      const msg = diff > 25 ? 'HIGH ▼' : diff < -18 ? 'LOW ▲' : 'ON SLOPE ●';
      const sink = -s.vel.y;
      g.font = `800 15px ${FONT}`;
      const text = `${msg}   sink ${fmtVs(sink)}`;
      const tw = g.measureText(text).width + 24;
      const y = this.clusterTop - 44;
      const cx = this.clusterCx;
      panel(g, cx - tw / 2, y, tw, 30);
      g.fillStyle = sink > 3 * LANDING_FORGIVENESS ? RED : INK;
      g.textAlign = 'center';
      g.fillText(text, cx, y + 21);
      g.textAlign = 'left';
    }
  }

  private renderMinimap(c: HudContext) {
    const m = this.mini.getContext('2d')!;
    const n = this.mini.width;
    const img = m.createImageData(n, n);
    const px = c.player.s.pos.x;
    const pz = c.player.s.pos.z;
    const span = this.miniSpan;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = px + (i / n - 0.5) * span;
        const z = pz + (j / n - 0.5) * span;
        const h = c.world.gen.rawHeight(x, z);
        let r: number, gg: number, b: number;
        if (h < 0) [r, gg, b] = h < -8 ? [70, 150, 205] : [110, 200, 220];
        else if (h < 5) [r, gg, b] = [240, 220, 160];
        else if (h > 440) [r, gg, b] = [250, 250, 255];
        else if (h > 300) [r, gg, b] = [170, 155, 140];
        else {
          const t = h / 300;
          r = 150 - t * 40;
          gg = 210 - t * 50;
          b = 90 - t * 20;
        }
        const k = (j * n + i) * 4;
        img.data[k] = r;
        img.data[k + 1] = gg;
        img.data[k + 2] = b;
        img.data[k + 3] = 255;
      }
    m.putImageData(img, 0, 0);
    this.miniAt.set(px, pz);
  }

  private drawMinimap(c: HudContext, size: number, top: number, right: number) {
    const s = c.player.s;
    if (this.miniT <= 0 && (Math.abs(s.pos.x - this.miniAt.x) > 400 || Math.abs(s.pos.z - this.miniAt.y) > 400)) {
      this.renderMinimap(c);
      this.miniT = 0.5;
    }
    const g = this.g;
    const x0 = this.w - right - size - 16;
    const y0 = top + MINI_TOP; // below the "Built with DAI Studio" badge in the top-right corner
    panel(g, x0, y0, size, size);
    g.save();
    roundRect(g, x0 + 3, y0 + 3, size - 6, size - 6, 10);
    g.clip();
    const span = this.miniSpan;
    const k = size / span;
    // the cached image is centred on miniAt
    const ox = (this.miniAt.x - s.pos.x) * k;
    const oz = (this.miniAt.y - s.pos.z) * k;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.mini, x0 + ox, y0 + oz, size, size);
    const toMap = (wx: number, wz: number) => ({ x: x0 + size / 2 + (wx - s.pos.x) * k, y: y0 + size / 2 + (wz - s.pos.z) * k });
    // cross-country route
    if (c.guide) {
      const pts = c.guide.route.pts;
      g.beginPath();
      for (let i = 0; i < pts.length; i += 4) {
        const p = toMap(pts[i].x, pts[i].z);
        if (i === 0) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
      g.lineJoin = 'round';
      g.strokeStyle = INK;
      g.lineWidth = 4;
      g.stroke();
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.stroke();
    }
    // airfields
    for (const af of c.world.gen.airfields) {
      const p = toMap(af.x, af.z);
      g.save();
      g.translate(p.x, p.y);
      g.rotate(af.heading);
      g.fillStyle = c.guide?.dest === af ? GOLD : af.home ? ACCENT : '#ffffff';
      g.strokeStyle = INK;
      g.lineWidth = 1.5;
      g.fillRect(-7, -2.5, 14, 5);
      g.strokeRect(-7, -2.5, 14, 5);
      g.restore();
    }
    g.restore();
    // player arrow
    c.player.forward(_fwd);
    const a = Math.atan2(_fwd.z, _fwd.x);
    g.save();
    g.translate(x0 + size / 2, y0 + size / 2);
    g.rotate(a);
    g.fillStyle = GOLD;
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(9, 0);
    g.lineTo(-6, -6);
    g.lineTo(-3, 0);
    g.lineTo(-6, 6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    g.font = `800 11px ${FONT}`;
    g.fillStyle = INK;
    g.fillText('N', x0 + size / 2 - 4, y0 + 15);
  }

  // ------------------------------------------------------------ touch (design §9.1, §9.2)

  /** Status card under the pause button: speed, altitude, flaps / stall warnings and damage (touch has no cluster). */
  private drawTouchStatus(c: HudContext, tv: TouchView) {
    const g = this.g;
    const l = tv.layout;
    const s = c.player.s;
    const p = l.buttons.pause;
    const x = l.safe.l + 12 * l.u;
    const y = p.y + p.r + 10 * l.u;
    // narrow enough to clear the objective banner on a 667 px phone
    const w = 158;
    const h = 106;
    panel(g, x, y, w, h);
    const agl = s.pos.y - Math.max(c.world.groundHeight(s.pos.x, s.pos.z), 0);
    const row = (label: string, value: string, unit: string, yy: number, color = INK) => {
      g.fillStyle = INK;
      g.font = `800 12px ${FONT}`;
      g.fillText(label, x + 10, yy);
      g.fillStyle = color;
      g.font = `800 18px ${FONT}`;
      g.fillText(value, x + 42, yy + 1);
      const vw = g.measureText(value).width;
      g.fillStyle = INK;
      g.font = `700 11px ${FONT}`;
      g.fillText(unit, x + 42 + vw + 4, yy + 1);
    };
    row('SPD', `${Math.round(speedOf(s.airspeed))}`, speedUnit(), y + 22, c.stallWarn ? RED : INK);
    row('ALT', `${Math.round(altOf(s.pos.y))}`, `${altUnit()} · ${Math.round(altOf(agl))} AGL`, y + 45);
    row('V/S', vsValue(s.vel.y), vsUnit(), y + 68);
    g.font = `800 12px ${FONT}`;
    if (c.stallWarn) {
      g.fillStyle = RED;
      g.fillText('STALL!', x + 10, y + 93);
    } else if (s.flapsBlown) {
      g.fillStyle = RED;
      g.fillText('TOO FAST for flaps!', x + 10, y + 93);
    } else {
      g.fillStyle = '#6b4b2a';
      g.fillText(`FLAPS ${FLAP_LABELS[c.flapNotch]}`, x + 10, y + 93);
    }
    g.save();
    g.translate(x + w - 20, y + h - 22);
    g.scale(0.3, 0.3);
    this.drawDamage(g, 0, 0, s.health);
    g.restore();
  }

  private drawTouchControls(c: HudContext, tv: TouchView) {
    const g = this.g;
    const l = tv.layout;
    const u = l.u;
    const font = (px: number) => `800 ${Math.max(11, Math.round(px * u))}px ${FONT}`;
    g.save();
    g.lineJoin = 'round';

    // stick: base where the thumb landed, knob under the thumb; a ghost at rest
    const st = tv.stick;
    const R = l.stickR;
    const bx = st ? st.ox : l.stickRest.x;
    const by = st ? st.oy : l.stickRest.y;
    g.globalAlpha = st ? 0.9 : tv.tilt ? 0.35 : 0.5;
    g.beginPath();
    g.arc(bx, by, R, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255, 246, 221, 0.28)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
    // up / down / left / right ticks
    g.lineWidth = 2.5;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      g.beginPath();
      g.moveTo(bx + Math.cos(a) * R * 0.78, by + Math.sin(a) * R * 0.78);
      g.lineTo(bx + Math.cos(a) * R * 0.92, by + Math.sin(a) * R * 0.92);
      g.stroke();
    }
    const kx = bx + (st ? st.x * R : 0);
    const ky = by + (st ? st.y * R : 0);
    g.beginPath();
    g.arc(kx, ky, R * 0.42, 0, Math.PI * 2);
    g.fillStyle = st ? GOLD : 'rgba(255, 246, 221, 0.85)';
    g.fill();
    g.lineWidth = 3;
    g.stroke();
    if (!st) {
      g.fillStyle = INK;
      g.font = font(11);
      g.textAlign = 'center';
      g.fillText(tv.tilt ? 'TILT' : 'FLY', kx, ky + 4 * u);
      g.textAlign = 'left';
    }
    g.globalAlpha = 1;

    // throttle lever: setting (wide fill), engine rpm / spool (thin inner bar), handle with %
    const lv = l.lever;
    const held = tv.held('lever');
    g.globalAlpha = held ? 0.95 : 0.8;
    roundRect(g, lv.x, lv.y, lv.w, lv.h, 12 * u);
    g.fillStyle = 'rgba(255, 246, 221, 0.55)';
    g.fill();
    g.save();
    g.clip();
    const fillH = lv.h * tv.throttle;
    g.fillStyle = 'rgba(242, 177, 52, 0.85)';
    g.fillRect(lv.x, lv.y + lv.h - fillH, lv.w, fillH);
    const rpm = c.player.s.rpm;
    g.fillStyle = 'rgba(224, 79, 58, 0.85)';
    g.fillRect(lv.x + lv.w - 7 * u, lv.y + lv.h - lv.h * rpm, 4 * u, lv.h * rpm);
    g.restore();
    roundRect(g, lv.x, lv.y, lv.w, lv.h, 12 * u);
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
    g.lineWidth = 1.5;
    for (const f of [0.25, 0.5, 0.75]) {
      const y = lv.y + lv.h * (1 - f);
      g.beginPath();
      g.moveTo(lv.x + 4, y);
      g.lineTo(lv.x + 12 * u, y);
      g.stroke();
    }
    const hy = lv.y + lv.h * (1 - tv.throttle);
    const hh = 24 * u;
    roundRect(g, lv.x - 6 * u, hy - hh / 2, lv.w + 12 * u, hh, 8 * u);
    g.fillStyle = held ? GOLD : PAPER;
    g.fill();
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = INK;
    g.font = font(12);
    g.textAlign = 'center';
    g.fillText(`${Math.round(tv.throttle * 100)}%`, lv.x + lv.w / 2, hy + 4.5 * u);
    g.font = font(10);
    const eng = engineOf(c.player.loadout.style);
    // label at the far end from the handle so they never overlap
    const top = tv.throttle < 0.6;
    g.fillText(eng === 'jet' ? `${Math.round(rpm * 100)}` : 'THR', lv.x + lv.w / 2, top ? lv.y + 16 * u : lv.y + lv.h - 8 * u);
    g.textAlign = 'left';
    g.globalAlpha = 1;

    // buttons
    const b = l.buttons;
    const blown = c.player.s.flapsBlown;
    this.touchButton(b.flapsLess, 'FLAP −', tv.held('flapsLess'), font(11));
    this.touchButton(b.flapsMore, 'FLAP +', tv.held('flapsMore'), font(11));
    // the flap notch between the two flap buttons
    g.font = font(12);
    g.textAlign = 'center';
    const ny = (b.flapsLess.y + b.flapsMore.y) / 2 + 4 * u;
    g.lineWidth = 4;
    g.strokeStyle = PAPER;
    const label = blown ? 'TOO FAST' : FLAP_LABELS[c.flapNotch];
    g.strokeText(label, b.flapsMore.x, ny);
    g.fillStyle = blown ? RED : INK;
    g.fillText(label, b.flapsMore.x, ny);
    g.textAlign = 'left';
    this.touchButton(b.brake, 'BRAKE', tv.held('brake'), font(13));
    this.touchButton(b.camera, 'CAM', tv.held('camera'), font(11));
    if (tv.bailShown) {
      this.touchButton(b.bail, 'BAIL', tv.held('bail'), font(11), '#f6c2b8');
      if (tv.bailProgress > 0) {
        g.beginPath();
        g.arc(b.bail.x, b.bail.y, b.bail.r + 5 * u, -Math.PI / 2, -Math.PI / 2 + tv.bailProgress * Math.PI * 2);
        g.lineWidth = 5 * u;
        g.strokeStyle = RED;
        g.stroke();
      }
    }
    // pause: two bars
    const p = b.pause;
    this.touchButton(p, '', tv.held('pause'), font(11));
    g.fillStyle = INK;
    g.fillRect(p.x - p.r * 0.32, p.y - p.r * 0.38, p.r * 0.22, p.r * 0.76);
    g.fillRect(p.x + p.r * 0.1, p.y - p.r * 0.38, p.r * 0.22, p.r * 0.76);
    g.restore();
  }

  private touchButton(c: Circle, label: string, down: boolean, font: string, fill = 'rgba(255, 246, 221, 0.78)') {
    const g = this.g;
    g.beginPath();
    g.arc(c.x + (down ? 0 : 3), c.y + (down ? 0 : 3), c.r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(43, 29, 26, 0.55)';
    g.fill();
    g.beginPath();
    g.arc(c.x + (down ? 2 : 0), c.y + (down ? 2 : 0), c.r, 0, Math.PI * 2);
    g.fillStyle = down ? ACCENT : fill;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
    if (!label) return;
    g.fillStyle = down ? '#fff' : INK;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, c.x + (down ? 2 : 0), c.y + (down ? 2 : 0) + 1);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
  }
}
