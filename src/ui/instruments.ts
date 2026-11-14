import type { PlaneSpec } from '../plane/flight';
import { loadoutStats, stallSpeed } from '../plane/loadout';

/**
 * Round "steam gauge" instruments drawn centre-bottom in flight (design §3 HUD & UI):
 * Airspeed Indicator (left), Attitude Indicator (centre), Altimeter (right).
 * Static dial faces are cached in offscreen canvases; only needles and the
 * attitude ball are drawn each frame.
 */
const INK = '#2b1d1a';
const FONT = '"Baloo 2", "Trebuchet MS", sans-serif';
const FACE = '#232427';
const FACE_EDGE = '#141416';
const MARK = '#f4f4f0';
const SKY = '#6fb6e6';
const SKY_DEEP = '#4f9fd8';
const GROUND = '#a87a55';
const GROUND_DEEP = '#8c6040';
const YELLOW = '#f5c51b';

/** gauge radius (CSS px at scale 1) and spacing */
export const GAUGE_R = 72;
const GAP = 14;
const PAD = 12;
export const CLUSTER_W = 6 * GAUGE_R + 2 * GAP + 2 * PAD;
export const CLUSTER_H = 2 * GAUGE_R + 2 * PAD;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

export interface AsiScale {
  /** top of the dial (km/h) */
  max: number;
  /** labelled step (km/h) */
  step: number;
  /** white arc: full-flap stall → max flap speed */
  white: [number, number];
  /** green arc: clean stall → max cruise */
  green: [number, number];
  /** yellow arc: max cruise → never exceed */
  yellow: [number, number];
  /** red line: never exceed */
  vne: number;
}

/** Airspeed markings for a plane (km/h), from its stall, flap and top speeds. */
export function asiScale(spec: PlaneSpec): AsiScale {
  const kmh = 3.6;
  const vs0 = stallSpeed(spec, 1) * kmh;
  const vs1 = stallSpeed(spec) * kmh;
  const vfe = spec.flapSpeed * kmh;
  const top = loadoutStats(spec).topSpeed * kmh;
  const vno = top * 0.92;
  const vne = top * 1.12;
  let step = 20;
  for (const s of [20, 40, 50, 100]) {
    step = s;
    if ((vne * 1.12) / s <= 7) break;
  }
  const max = Math.ceil((vne * 1.08) / step) * step;
  return { max, step, white: [vs0, vfe], green: [vs1, vno], yellow: [vno, vne], vne };
}

/** ASI needle angle (rad, canvas: 0 = 3 o'clock, clockwise): 0 at 12 o'clock, full scale over 330°. */
export function asiAngle(kmh: number, max: number): number {
  const t = Math.min(Math.max(kmh, 0), max * 1.02) / max;
  return -Math.PI / 2 + t * 330 * DEG;
}

/** Altimeter hand angles: long hand one turn per 1000 m, short hand one turn per 10 000 m. */
export function altimeterAngles(m: number): { hundreds: number; thousands: number } {
  const a = (turns: number) => -Math.PI / 2 + turns * TAU;
  return { hundreds: a(m / 1000), thousands: a(m / 10000) };
}

export interface InstrumentData {
  /** indicated airspeed (m/s) */
  airspeed: number;
  /** altitude above sea level (m) */
  altitude: number;
  /** nose up + (rad) */
  pitch: number;
  /** right wing down + (rad) */
  bank: number;
  spec: PlaneSpec;
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

/** Black bezel, dark face with a soft vignette (shared by the ASI and the altimeter). */
function drawBezel(g: CanvasRenderingContext2D, R: number) {
  // ink drop shadow + outline in the HUD's cartoon style
  g.fillStyle = INK;
  g.beginPath();
  g.arc(3, 4, R, 0, TAU);
  g.fill();
  const rim = g.createLinearGradient(0, -R, 0, R);
  rim.addColorStop(0, '#4a4b50');
  rim.addColorStop(0.5, '#1b1c1f');
  rim.addColorStop(1, '#3a3b40');
  g.fillStyle = rim;
  g.beginPath();
  g.arc(0, 0, R, 0, TAU);
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.stroke();
}

function drawFace(g: CanvasRenderingContext2D, r: number) {
  const face = g.createRadialGradient(-r * 0.2, -r * 0.3, r * 0.1, 0, 0, r);
  face.addColorStop(0, '#3b3c41');
  face.addColorStop(0.7, FACE);
  face.addColorStop(1, FACE_EDGE);
  g.fillStyle = face;
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
  g.fill();
}

/** Glass glare over a dial. */
function drawGlass(g: CanvasRenderingContext2D, r: number) {
  g.save();
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
  g.clip();
  const glare = g.createLinearGradient(-r, -r, r * 0.4, r * 0.4);
  glare.addColorStop(0, 'rgba(255,255,255,0.16)');
  glare.addColorStop(0.45, 'rgba(255,255,255,0.03)');
  glare.addColorStop(0.46, 'rgba(255,255,255,0)');
  g.fillStyle = glare;
  g.fillRect(-r, -r, 2 * r, 2 * r);
  g.restore();
}

function tick(g: CanvasRenderingContext2D, a: number, r0: number, r1: number, w: number, color = MARK) {
  g.strokeStyle = color;
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
  g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
  g.stroke();
}

/** A tapered white needle with a counterweight tail. */
function needle(g: CanvasRenderingContext2D, a: number, len: number, w: number, tail: number) {
  g.save();
  g.rotate(a);
  g.fillStyle = MARK;
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(len, 0);
  g.lineTo(len * 0.15, -w);
  g.lineTo(-tail, -w * 0.8);
  g.lineTo(-tail, w * 0.8);
  g.lineTo(len * 0.15, w);
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
}

function hub(g: CanvasRenderingContext2D, r: number) {
  g.fillStyle = '#111';
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
  g.fill();
  g.fillStyle = '#555';
  g.beginPath();
  g.arc(-r * 0.25, -r * 0.25, r * 0.35, 0, TAU);
  g.fill();
}

export class Instruments {
  private asiFace: HTMLCanvasElement | null = null;
  private altFace: HTMLCanvasElement | null = null;
  private faceKey = '';
  private scale: AsiScale | null = null;
  private scaleSpec: PlaneSpec | null = null;

  /** Draw the cluster with its top-left at (x, y), already scaled by the caller's transform. */
  draw(g: CanvasRenderingContext2D, x: number, y: number, pxScale: number, d: InstrumentData) {
    if (d.spec !== this.scaleSpec) {
      this.scale = asiScale(d.spec);
      this.scaleSpec = d.spec;
      this.faceKey = '';
    }
    const R = GAUGE_R;
    const size = Math.ceil((2 * R + 8) * pxScale);
    const key = `${size}:${this.scale!.max}`;
    if (key !== this.faceKey) {
      this.asiFace = this.buildAsiFace(size, pxScale, this.scale!);
      this.altFace = this.buildAltFace(size, pxScale);
      this.faceKey = key;
    }

    // brushed grey backing plate
    const W = CLUSTER_W;
    const H = CLUSTER_H;
    g.save();
    g.translate(x, y);
    g.fillStyle = INK;
    roundRect(g, 4, 4, W, H, 18);
    g.fill();
    const plate = g.createLinearGradient(0, 0, 0, H);
    plate.addColorStop(0, '#8d9096');
    plate.addColorStop(1, '#6c6f75');
    g.fillStyle = plate;
    roundRect(g, 0, 0, W, H, 18);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
    // screws
    g.fillStyle = '#5a5d63';
    for (const [sx, sy] of [
      [10, 10],
      [W - 10, 10],
      [10, H - 10],
      [W - 10, H - 10],
    ]) {
      g.beginPath();
      g.arc(sx, sy, 3, 0, TAU);
      g.fill();
    }

    const cy = PAD + R;
    const cx = [PAD + R, PAD + 3 * R + GAP, PAD + 5 * R + 2 * GAP];
    const half = size / pxScale / 2;

    // ---- airspeed
    g.save();
    g.translate(cx[0], cy);
    g.drawImage(this.asiFace!, -half, -half, size / pxScale, size / pxScale);
    needle(g, asiAngle(d.airspeed * 3.6, this.scale!.max), R * 0.76, 3.2, R * 0.2);
    hub(g, R * 0.1);
    drawGlass(g, R * 0.88);
    g.restore();

    // ---- attitude
    g.save();
    g.translate(cx[1], cy);
    this.drawAttitude(g, R, d.pitch, d.bank);
    g.restore();

    // ---- altimeter
    g.save();
    g.translate(cx[2], cy);
    g.drawImage(this.altFace!, -half, -half, size / pxScale, size / pxScale);
    const hands = altimeterAngles(Math.max(d.altitude, 0));
    // low-altitude flag: the hatched window shows below 3000 m (like the 10 000 ft flag)
    if (d.altitude < 3000) this.drawLowAltFlag(g, R);
    // short (thousands) hand: wide, short, arrow-tipped
    g.save();
    g.rotate(hands.thousands);
    g.fillStyle = MARK;
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(R * 0.5, 0);
    g.lineTo(R * 0.3, -6);
    g.lineTo(0, -4);
    g.lineTo(0, 4);
    g.lineTo(R * 0.3, 6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    needle(g, hands.hundreds, R * 0.78, 2.6, R * 0.12);
    hub(g, R * 0.09);
    drawGlass(g, R * 0.88);
    g.restore();

    g.restore();
  }

  private drawLowAltFlag(g: CanvasRenderingContext2D, R: number) {
    // a small window below the hub with black/white stripes (drawn under the hands)
    g.save();
    g.beginPath();
    g.moveTo(0, R * 0.12);
    g.arc(0, 0, R * 0.44, 62 * DEG, 118 * DEG);
    g.closePath();
    g.clip();
    g.fillStyle = '#111';
    g.fillRect(-R, 0, 2 * R, R);
    g.strokeStyle = MARK;
    g.lineWidth = 4;
    for (let i = -8; i < 8; i++) {
      g.beginPath();
      g.moveTo(i * 9, R * 0.1);
      g.lineTo(i * 9 + R * 0.5, R * 0.6);
      g.stroke();
    }
    g.restore();
  }

  private drawAttitude(g: CanvasRenderingContext2D, R: number, pitch: number, bank: number) {
    drawBezel(g, R);
    const rRing = R * 0.88;
    const rBall = R * 0.66;
    const pxPerDeg = rBall / 32;
    const pitchDeg = Math.max(-90, Math.min(90, pitch / DEG));

    // outer ring: sky/ground split that rolls with bank (no pitch), with the bank scale
    g.save();
    g.beginPath();
    g.arc(0, 0, rRing, 0, TAU);
    g.clip();
    g.rotate(-bank);
    g.fillStyle = SKY_DEEP;
    g.fillRect(-R, -R, 2 * R, R);
    g.fillStyle = GROUND_DEEP;
    g.fillRect(-R, 0, 2 * R, R);
    g.strokeStyle = MARK;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-R, 0);
    g.lineTo(R, 0);
    g.stroke();
    for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const a = -Math.PI / 2 + b * DEG;
      const big = b % 30 === 0;
      if (Math.abs(b) === 45) {
        // small triangles at 45°
        g.save();
        g.rotate(a + Math.PI / 2);
        g.fillStyle = MARK;
        g.beginPath();
        g.moveTo(0, -rRing * 0.8);
        g.lineTo(-4, -rRing * 0.97);
        g.lineTo(4, -rRing * 0.97);
        g.closePath();
        g.fill();
        g.restore();
      } else tick(g, a, rRing * (big ? 0.76 : 0.82), rRing * 0.98, big ? 3 : 2);
    }
    // zero-bank triangle on the ring
    g.fillStyle = MARK;
    g.beginPath();
    g.moveTo(0, -rRing * 0.78);
    g.lineTo(-7, -rRing * 0.98);
    g.lineTo(7, -rRing * 0.98);
    g.closePath();
    g.fill();
    g.restore();

    // inner ball: sky/ground and pitch ladder, rolls with bank and slides with pitch
    g.save();
    g.beginPath();
    g.arc(0, 0, rBall, 0, TAU);
    g.clip();
    g.rotate(-bank);
    g.translate(0, pitchDeg * pxPerDeg);
    const span = 200 * pxPerDeg;
    const sky = g.createLinearGradient(0, -rBall * 1.2, 0, 0);
    sky.addColorStop(0, SKY_DEEP);
    sky.addColorStop(1, SKY);
    g.fillStyle = sky;
    g.fillRect(-R, -span, 2 * R, span);
    const ground = g.createLinearGradient(0, 0, 0, rBall * 1.2);
    ground.addColorStop(0, GROUND);
    ground.addColorStop(1, GROUND_DEEP);
    g.fillStyle = ground;
    g.fillRect(-R, 0, 2 * R, span);
    g.strokeStyle = MARK;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-R, 0);
    g.lineTo(R, 0);
    g.stroke();
    g.font = `700 ${Math.round(R * 0.1)}px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillStyle = MARK;
    for (let p = -30; p <= 30; p += 5) {
      if (p === 0) continue;
      const yy = -p * pxPerDeg;
      const w = p % 10 === 0 ? rBall * 0.42 : rBall * 0.18;
      g.lineWidth = p % 10 === 0 ? 1.6 : 1.2;
      g.beginPath();
      g.moveTo(-w / 2, yy);
      g.lineTo(w / 2, yy);
      g.stroke();
      if (p % 10 === 0) {
        g.textAlign = 'right';
        g.fillText(String(Math.abs(p)), -w / 2 - 3, yy);
        g.textAlign = 'left';
        g.fillText(String(Math.abs(p)), w / 2 + 3, yy);
      }
    }
    g.restore();
    // ball edge shading
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(0, 0, rBall, 0, TAU);
    g.stroke();

    // fixed parts: yellow bank index, the miniature aeroplane, the case bottom with the knob
    g.strokeStyle = YELLOW;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(0, -rRing * 0.78);
    g.lineTo(-6, -rRing * 0.62);
    g.lineTo(6, -rRing * 0.62);
    g.closePath();
    g.stroke();

    g.save();
    g.beginPath();
    g.arc(0, 0, rRing, 0, TAU);
    g.clip();
    g.fillStyle = '#1b1c1f';
    g.fillRect(-R, rRing * 0.72, 2 * R, R);
    g.restore();
    g.fillStyle = '#0e0e10';
    g.beginPath();
    g.arc(0, R * 0.8, R * 0.17, 0, TAU);
    g.fill();

    g.fillStyle = YELLOW;
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 1;
    const wing = (sgn: number) => {
      g.beginPath();
      g.moveTo(sgn * rBall * 0.92, -2.5);
      g.lineTo(sgn * rBall * 0.3, -2.5);
      g.lineTo(sgn * rBall * 0.18, 7);
      g.lineTo(sgn * rBall * 0.12, 7);
      g.lineTo(sgn * rBall * 0.22, 2.5);
      g.lineTo(sgn * rBall * 0.92, 2.5);
      g.closePath();
      g.fill();
      g.stroke();
    };
    wing(-1);
    wing(1);
    g.beginPath();
    g.arc(0, 0, 3.5, 0, TAU);
    g.fill();
    g.stroke();
    drawGlass(g, rRing);
  }

  private buildAsiFace(size: number, k: number, sc: AsiScale): HTMLCanvasElement {
    const [c, g] = makeCanvas(size);
    const R = GAUGE_R;
    g.setTransform(k, 0, 0, k, size / 2, size / 2);
    drawBezel(g, R);
    const r = R * 0.88;
    drawFace(g, r);
    // coloured arcs (green/yellow outside, white inside like the reference)
    const arc = (v0: number, v1: number, rr: number, w: number, col: string) => {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.beginPath();
      g.arc(0, 0, rr, asiAngle(v0, sc.max), asiAngle(v1, sc.max));
      g.stroke();
    };
    arc(sc.green[0], sc.green[1], r * 0.92, 6, '#3fb24a');
    arc(sc.yellow[0], sc.yellow[1], r * 0.92, 6, '#f2c230');
    arc(sc.white[0], sc.white[1], r * 0.8, 4, MARK);
    tick(g, asiAngle(sc.vne, sc.max), r * 0.72, r * 0.99, 4, '#e2342b');
    // ticks: minor every step/4, major every step/2, labels every step
    const minor = sc.step / 4;
    for (let v = 0; v <= sc.max + 1e-6; v += minor) {
      const a = asiAngle(v, sc.max);
      const n = Math.round(v / minor);
      if (n % 4 === 0) tick(g, a, r * 0.74, r * 0.97, 2.4);
      else if (n % 2 === 0) tick(g, a, r * 0.8, r * 0.97, 1.8);
      else tick(g, a, r * 0.87, r * 0.97, 1.2);
    }
    g.fillStyle = MARK;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 ${Math.round(R * 0.17)}px ${FONT}`;
    for (let v = sc.step; v <= sc.max + 1e-6; v += sc.step) {
      const a = asiAngle(v, sc.max);
      g.fillText(String(v), Math.cos(a) * r * 0.56, Math.sin(a) * r * 0.56);
    }
    g.font = `800 ${Math.round(R * 0.12)}px ${FONT}`;
    g.fillText('AIRSPEED', 0, -r * 0.22);
    g.font = `700 ${Math.round(R * 0.11)}px ${FONT}`;
    g.fillText('KM/H', 0, r * 0.3);
    return c;
  }

  private buildAltFace(size: number, k: number): HTMLCanvasElement {
    const [c, g] = makeCanvas(size);
    const R = GAUGE_R;
    g.setTransform(k, 0, 0, k, size / 2, size / 2);
    drawBezel(g, R);
    const r = R * 0.88;
    drawFace(g, r);
    for (let i = 0; i < 50; i++) {
      const a = -Math.PI / 2 + (i / 50) * TAU;
      if (i % 5 === 0) tick(g, a, r * 0.8, r * 0.97, 2.4);
      else tick(g, a, r * 0.88, r * 0.97, 1.2);
    }
    // zero index triangle
    g.fillStyle = MARK;
    g.beginPath();
    g.moveTo(0, -r * 0.8);
    g.lineTo(-5, -r * 0.98);
    g.lineTo(5, -r * 0.98);
    g.closePath();
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 ${Math.round(R * 0.22)}px ${FONT}`;
    for (let n = 0; n < 10; n++) {
      const a = -Math.PI / 2 + (n / 10) * TAU;
      g.fillText(String(n), Math.cos(a) * r * 0.64, Math.sin(a) * r * 0.64);
    }
    g.font = `800 ${Math.round(R * 0.14)}px ${FONT}`;
    g.fillText('ALT', 0, -r * 0.24);
    g.font = `700 ${Math.round(R * 0.085)}px ${FONT}`;
    g.fillText('×100 METRES', 0, -r * 0.4);
    return c;
  }
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
