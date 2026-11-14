import * as THREE from 'three';
import type { Plane } from '../plane/plane';
import { LANDING_FORGIVENESS } from '../plane/flight';
import { engineOf } from '../plane/loadout';
import type { World } from '../world/world';
import type { Route } from '../game/route';
import type { Airfield } from '../world/terrain';

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

export interface HudContext {
  player: Plane;
  world: World;
  camera: THREE.PerspectiveCamera;
  objective: string;
  mouseStick: boolean;
  mouse: { x: number; y: number };
  stallWarn: boolean;
  showLanding: boolean;
  /** cross-country flight: the route, destination and (when off the path) where to rejoin it */
  guide?: { route: Route; dest: Airfield; rejoin: THREE.Vector3 | null };
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
    const compact = this.w < 700;
    const sc = compact ? 0.8 : 1;

    // ---------- markers in the world
    this.drawMouseStick(c);
    if (c.showLanding) this.drawLandingGuide(c);
    if (c.guide?.rejoin) this.drawRejoin(c.guide.rejoin, c.camera);

    // ---------- bottom-left gauges
    g.save();
    g.translate(16, this.h - 16 - 150 * sc);
    g.scale(sc, sc);
    panel(g, 0, 0, 220, 150);
    const kmh = s.airspeed * 3.6;
    const agl = s.pos.y - Math.max(c.world.groundHeight(s.pos.x, s.pos.z), 0);
    g.fillStyle = INK;
    g.font = `800 14px ${FONT}`;
    g.fillText('SPEED', 14, 24);
    g.fillText('ALT', 120, 24);
    g.font = `800 30px ${FONT}`;
    g.fillStyle = c.stallWarn ? RED : INK;
    const kmhStr = `${Math.round(kmh)}`;
    g.fillText(kmhStr, 14, 56);
    const kw = g.measureText(kmhStr).width;
    g.fillStyle = INK;
    g.fillText(`${Math.round(s.pos.y)}`, 120, 56);
    g.font = `700 13px ${FONT}`;
    g.fillText('km/h', 14 + kw + 4, 56);
    g.fillText(`m  (${Math.round(agl)} AGL)`, 120, 74);
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

    // ---------- top: compass ribbon + objective
    this.drawCompass(c);
    g.font = `800 ${compact ? 14 : 16}px ${FONT}`;
    g.textAlign = 'center';
    const objW = g.measureText(c.objective).width + 28;
    panel(g, this.w / 2 - objW / 2, 62, objW, 30);
    g.fillStyle = INK;
    g.fillText(c.objective, this.w / 2, 83);
    g.textAlign = 'left';

    // ---------- minimap (top-right)
    this.miniT -= dt;
    this.drawMinimap(c, compact ? 120 : 160);
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

  private drawCompass(c: HudContext) {
    const g = this.g;
    const w = Math.min(420, this.w - 40);
    const x0 = this.w / 2 - w / 2;
    const y0 = 12;
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
      const text = `${msg}   sink ${sink.toFixed(1)} m/s`;
      const tw = g.measureText(text).width + 24;
      panel(g, this.w / 2 - tw / 2, this.h - 120, tw, 30);
      g.fillStyle = sink > 3 * LANDING_FORGIVENESS ? RED : INK;
      g.textAlign = 'center';
      g.fillText(text, this.w / 2, this.h - 99);
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

  private drawMinimap(c: HudContext, size: number) {
    const s = c.player.s;
    if (this.miniT <= 0 && (Math.abs(s.pos.x - this.miniAt.x) > 400 || Math.abs(s.pos.z - this.miniAt.y) > 400)) {
      this.renderMinimap(c);
      this.miniT = 0.5;
    }
    const g = this.g;
    const x0 = this.w - size - 16;
    const y0 = 46; // below the "Built with DAI Studio" badge in the top-right corner
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
}
