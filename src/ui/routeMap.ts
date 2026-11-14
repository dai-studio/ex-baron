import type { Route } from '../game/route';
import type { TerrainGen } from '../world/terrain';

/**
 * Menu map of a cross-country flight plan (plan step 22): shaded terrain,
 * every airfield, the route with direction chevrons, home and destination
 * markers, north arrow and scale bar. North (−z) is up, as on the minimap.
 */
const INK = '#2b1d1a';
const PAPER = '#fff6dd';
const ACCENT = '#2a9d8f';
const GOLD = '#f2b134';
const FONT = '"Baloo 2", "Trebuchet MS", sans-serif';

function terrainColour(h: number): [number, number, number] {
  if (h < 0) return h < -25 ? [70, 150, 205] : h < -8 ? [92, 176, 216] : [124, 206, 222];
  if (h < 5) return [240, 220, 160];
  if (h > 440) return [250, 250, 255];
  if (h > 300) return [170, 155, 140];
  const t = h / 300;
  return [150 - t * 40, 210 - t * 50, 90 - t * 20];
}

export function drawRouteMap(canvas: HTMLCanvasElement, gen: TerrainGen, route: Route, names: string[]) {
  const W = canvas.width;
  const H = canvas.height;
  const g = canvas.getContext('2d')!;

  // frame: the route plus a margin, at the canvas aspect ratio
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of route.pts) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z);
    z1 = Math.max(z1, p.z);
  }
  const pad = 1400;
  x0 -= pad;
  x1 += pad;
  z0 -= pad;
  z1 += pad;
  const span = Math.max((x1 - x0) / W, (z1 - z0) / H); // metres per pixel
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const toMap = (x: number, z: number) => ({ x: W / 2 + (x - cx) / span, y: H / 2 + (z - cz) / span });

  // shaded terrain, sampled coarsely and scaled up
  const n = 4; // px per sample
  const sw = Math.ceil(W / n) + 1;
  const sh = Math.ceil(H / n) + 1;
  const hs = new Float32Array(sw * sh);
  for (let j = 0; j < sh; j++)
    for (let i = 0; i < sw; i++) hs[j * sw + i] = gen.rawHeight(cx + (i * n - W / 2) * span, cz + (j * n - H / 2) * span);
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sg = small.getContext('2d')!;
  const img = sg.createImageData(sw, sh);
  for (let j = 0; j < sh; j++)
    for (let i = 0; i < sw; i++) {
      const h = hs[j * sw + i];
      const [r, gg, b] = terrainColour(h);
      // light from the north-west
      const hl = hs[j * sw + Math.max(0, i - 1)];
      const hu = hs[Math.max(0, j - 1) * sw + i];
      const shade = h < 0 ? 1 : Math.max(0.75, Math.min(1.2, 1 + (hl - h + (hu - h)) * 0.004));
      const k = (j * sw + i) * 4;
      img.data[k] = r * shade;
      img.data[k + 1] = gg * shade;
      img.data[k + 2] = b * shade;
      img.data[k + 3] = 255;
    }
  sg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.clearRect(0, 0, W, H);
  g.drawImage(small, 0, 0, sw * n, sh * n);

  const px = canvas.clientWidth ? W / canvas.clientWidth : 2; // ui scale: canvas px per css px

  // airfields
  const runway = (i: number, fill: string) => {
    const af = gen.airfields[i];
    const p = toMap(af.x, af.z);
    const len = Math.max(af.length / span, 14 * px);
    g.save();
    g.translate(p.x, p.y);
    g.rotate(af.heading);
    g.fillStyle = fill;
    g.strokeStyle = INK;
    g.lineWidth = 2 * px;
    g.fillRect(-len / 2, -3 * px, len, 6 * px);
    g.strokeRect(-len / 2, -3 * px, len, 6 * px);
    g.restore();
    return p;
  };
  for (let i = 0; i < gen.airfields.length; i++) if (gen.airfields[i] !== route.from && gen.airfields[i] !== route.to) runway(i, '#ffffff');

  // the route: ink casing, white line, chevrons every ~1/12 of the way
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.beginPath();
  route.pts.forEach((p, i) => {
    const m = toMap(p.x, p.z);
    if (i === 0) g.moveTo(m.x, m.y);
    else g.lineTo(m.x, m.y);
  });
  g.strokeStyle = INK;
  g.lineWidth = 7 * px;
  g.stroke();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3.5 * px;
  g.stroke();
  const every = Math.max(800, route.length / 12);
  for (let d = every / 2; d < route.sAim; d += every) {
    let j = 0;
    while (j < route.pts.length - 2 && route.pts[j + 1].s < d) j++;
    const a = toMap(route.pts[Math.max(0, j - 2)].x, route.pts[Math.max(0, j - 2)].z);
    const b = toMap(route.pts[Math.min(route.pts.length - 1, j + 2)].x, route.pts[Math.min(route.pts.length - 1, j + 2)].z);
    const m = toMap(route.pts[j].x, route.pts[j].z);
    g.save();
    g.translate(m.x, m.y);
    g.rotate(Math.atan2(b.y - a.y, b.x - a.x));
    g.beginPath();
    g.moveTo(5 * px, 0);
    g.lineTo(-4 * px, -5 * px);
    g.lineTo(-1.5 * px, 0);
    g.lineTo(-4 * px, 5 * px);
    g.closePath();
    g.fillStyle = ACCENT;
    g.strokeStyle = INK;
    g.lineWidth = 1.5 * px;
    g.fill();
    g.stroke();
    g.restore();
  }

  // home and destination
  const label = (text: string, p: { x: number; y: number }, fill: string) => {
    g.font = `800 ${13 * px}px ${FONT}`;
    const tw = g.measureText(text).width + 12 * px;
    const th = 20 * px;
    let lx = p.x - tw / 2;
    let ly = p.y - 14 * px - th;
    if (ly < 4 * px) ly = p.y + 14 * px;
    lx = Math.max(4 * px, Math.min(W - tw - 4 * px, lx));
    g.fillStyle = INK;
    g.beginPath();
    g.roundRect(lx + 2 * px, ly + 2 * px, tw, th, 7 * px);
    g.fill();
    g.fillStyle = fill;
    g.beginPath();
    g.roundRect(lx, ly, tw, th, 7 * px);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 2 * px;
    g.stroke();
    g.fillStyle = INK;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, lx + tw / 2, ly + th / 2 + px);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  };
  const home = runway(gen.airfields.indexOf(route.from), ACCENT);
  const dest = runway(gen.airfields.indexOf(route.to), GOLD);
  label('Home', home, PAPER);
  label(names[gen.airfields.indexOf(route.to)], dest, GOLD);

  // north arrow
  g.save();
  g.translate(W - 22 * px, 26 * px);
  g.fillStyle = PAPER;
  g.strokeStyle = INK;
  g.lineWidth = 2 * px;
  g.beginPath();
  g.arc(0, 0, 14 * px, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = INK;
  g.beginPath();
  g.moveTo(0, -10 * px);
  g.lineTo(-5 * px, 3 * px);
  g.lineTo(5 * px, 3 * px);
  g.closePath();
  g.fill();
  g.font = `800 ${9 * px}px ${FONT}`;
  g.textAlign = 'center';
  g.fillText('N', 0, 11 * px);
  g.restore();

  // scale bar
  const km = [1, 2, 5, 10].find((k) => (k * 1000) / span > 50 * px) ?? 10;
  const len = (km * 1000) / span;
  const sx = 12 * px;
  const sy = H - 14 * px;
  g.fillStyle = PAPER;
  g.strokeStyle = INK;
  g.lineWidth = 2 * px;
  g.fillRect(sx, sy - 5 * px, len, 6 * px);
  g.strokeRect(sx, sy - 5 * px, len, 6 * px);
  g.fillStyle = INK;
  g.font = `800 ${11 * px}px ${FONT}`;
  g.textAlign = 'left';
  g.fillText(`${km} km`, sx + len + 6 * px, sy + 1 * px);
}
