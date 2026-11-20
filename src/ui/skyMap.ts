import type { SkyPlan, SmokePoint } from '../game/skywriting';

/**
 * Pictures of a skywriting plan (plan step 52), in text space so the message
 * always reads left to right: the menu preview (letters and the flight path),
 * the HUD card (a window that scrolls along with the plane) and the debrief
 * picture (the letters faint, the smoke actually written on top).
 */
const INK = '#2b1d1a';
const HOT = '#ff7a3d';
const GOLD = '#f2b134';

export interface SkyView {
  /** the flight path: connectors dashed, smoke segments in orange */
  path?: boolean;
  /** how to draw the letters: as white smoke (preview) or as a faint ghost (under the real smoke) */
  letters?: 'smoke' | 'ghost';
  /** smoke actually written */
  smoke?: SmokePoint[];
  /** smoke segment to highlight (the current / next one) */
  highlight?: number;
  /** the plane in text space, heading in radians (atan2(dv, du)) */
  plane?: { u: number; v: number; h: number };
  /** text-space window to show; default: the whole path (with `path`) or the letters */
  win?: { u0: number; u1: number; v0: number; v1: number };
}

export function drawSkyView(g: CanvasRenderingContext2D, plan: SkyPlan, x: number, y: number, w: number, h: number, o: SkyView) {
  let win = o.win;
  if (!win) {
    if (o.path) {
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (const p of plan.uv) {
        u0 = Math.min(u0, p.u);
        u1 = Math.max(u1, p.u);
        v0 = Math.min(v0, p.v);
        v1 = Math.max(v1, p.v);
      }
      win = { u0, u1, v0, v1 };
    } else {
      const m = plan.H * 0.25;
      win = { u0: -m, u1: plan.width + m, v0: -m, v1: plan.H + m };
    }
  }
  const pad = 10;
  const k = Math.min((w - 2 * pad) / (win.u1 - win.u0), (h - 2 * pad) / (win.v1 - win.v0));
  const cu = (win.u0 + win.u1) / 2;
  const cv = (win.v0 + win.v1) / 2;
  const X = (u: number) => x + w / 2 + (u - cu) * k;
  const Y = (v: number) => y + h / 2 - (v - cv) * k;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.lineJoin = 'round';
  g.lineCap = 'round';

  const poly = (i0: number, i1: number, step = 1) => {
    g.beginPath();
    for (let i = i0; i <= i1; i += step) {
      const p = plan.uv[i];
      if (i === i0) g.moveTo(X(p.u), Y(p.v));
      else g.lineTo(X(p.u), Y(p.v));
    }
    const l = plan.uv[i1];
    g.lineTo(X(l.u), Y(l.v));
  };
  const strokeWidth = Math.max(3, plan.H * 0.06 * k);

  if (o.path) {
    // connectors: thin dashed ink
    g.setLineDash([5, 5]);
    g.strokeStyle = 'rgba(43,29,26,0.55)';
    g.lineWidth = 1.5;
    poly(0, plan.uv.length - 1, 2);
    g.stroke();
    g.setLineDash([]);
  }

  if (o.letters) {
    for (const st of plan.strokes) {
      g.beginPath();
      st.pts.forEach((p, i) => (i ? g.lineTo(X(p.u), Y(p.v)) : g.moveTo(X(p.u), Y(p.v))));
      if (o.letters === 'smoke') {
        g.strokeStyle = INK;
        g.lineWidth = strokeWidth + 3;
        g.stroke();
        g.strokeStyle = '#ffffff';
        g.lineWidth = strokeWidth;
        g.stroke();
      } else {
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = strokeWidth;
        g.stroke();
      }
    }
  }

  if (o.path) {
    // smoke segments in orange over the letters, with a start dot
    for (let i = 0; i < plan.smoke.length; i++) {
      const sg = plan.smoke[i];
      poly(sg.i0, sg.i1);
      g.strokeStyle = HOT;
      g.lineWidth = o.highlight === i ? 3.5 : 1.5;
      g.stroke();
    }
    const a = plan.uv[0];
    g.fillStyle = GOLD;
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(X(a.u), Y(a.v), 5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  } else if (o.highlight !== undefined && o.highlight < plan.smoke.length) {
    const sg = plan.smoke[o.highlight];
    poly(sg.i0, sg.i1);
    g.strokeStyle = HOT;
    g.lineWidth = Math.max(2, strokeWidth * 0.35);
    g.stroke();
  }

  if (o.smoke?.length) {
    const r = Math.max(1.6, plan.H * 0.03 * k);
    g.fillStyle = INK;
    for (const p of o.smoke) {
      g.beginPath();
      g.arc(X(p.u), Y(p.v), r + 1.5, 0, Math.PI * 2);
      g.fill();
    }
    for (const p of o.smoke) {
      // smoke well off the writing altitude looks thin
      g.fillStyle = Math.abs(p.dy) < plan.H * 0.3 ? '#ffffff' : '#d9d2c5';
      g.beginPath();
      g.arc(X(p.u), Y(p.v), r, 0, Math.PI * 2);
      g.fill();
    }
  }

  if (o.plane) {
    g.save();
    g.translate(X(o.plane.u), Y(o.plane.v));
    g.rotate(-o.plane.h);
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
  }
  g.restore();
}

/** The menu preview / debrief picture: fill a canvas at its on-screen size. */
export function drawSkyCanvas(c: HTMLCanvasElement, plan: SkyPlan, o: SkyView) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.max(1, Math.round(c.clientWidth * dpr));
  c.height = Math.max(1, Math.round(c.clientHeight * dpr));
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = c.clientWidth;
  const h = c.clientHeight;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#7cc4ea');
  sky.addColorStop(1, '#bfe4f6');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  drawSkyView(g, plan, 0, 0, w, h, o);
}
