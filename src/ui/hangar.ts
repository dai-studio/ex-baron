import {
  PAINTS,
  STYLES,
  WHEELS,
  composeSpec,
  describeLoadout,
  loadoutStats,
  saveLoadout,
  type Loadout,
  type LoadoutStats,
} from '../plane/loadout';

/**
 * Hangar screen (design §8.1): Plane / Paint / Wheels tabs (the engine comes with the plane), option
 * cards, stat bars from the composed PlaneSpec, keyboard and gamepad
 * navigation. The 3D preview lives in the game (main canvas).
 */
type Cat = keyof Loadout;
const CATS: { id: Cat; label: string }[] = [
  { id: 'style', label: 'Plane' },
  { id: 'paint', label: 'Paint' },
  { id: 'wheels', label: 'Wheels' },
];

interface Card {
  id: string;
  name: string;
  trait?: string;
  icon?: string;
  swatch?: string;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

const OPTIONS: Record<Cat, Card[]> = {
  style: STYLES,
  paint: PAINTS.map((p) => ({ id: p.id, name: p.name, swatch: `linear-gradient(135deg, ${hex(p.body)} 0 62%, ${hex(p.accent)} 62% 100%)` })),
  wheels: WHEELS,
};

interface StatRow {
  key: keyof LoadoutStats;
  label: string;
  bar: (s: LoadoutStats) => number;
  text: (s: LoadoutStats) => string;
  /** value used for the +/- delta, and its unit */
  delta: (s: LoadoutStats) => number;
  better: 1 | -1;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const STATS: StatRow[] = [
  { key: 'topSpeed', label: 'Top speed', bar: (s) => clamp01((s.topSpeed * 3.6) / 500), text: (s) => `${Math.round(s.topSpeed * 3.6)} km/h`, delta: (s) => Math.round(s.topSpeed * 3.6), better: 1 },
  { key: 'climb', label: 'Climb', bar: (s) => clamp01(s.climb / 20), text: (s) => `${s.climb.toFixed(1)} m/s`, delta: (s) => Math.round(s.climb * 10) / 10, better: 1 },
  { key: 'handling', label: 'Handling', bar: (s) => s.handling, text: (s) => `${Math.round(s.handling * 10)}/10`, delta: (s) => Math.round(s.handling * 10), better: 1 },
  { key: 'takeoffRun', label: 'Short takeoff', bar: (s) => clamp01(1 - s.takeoffRun / 650), text: (s) => `${Math.round(s.takeoffRun / 10) * 10} m run`, delta: (s) => Math.round(s.takeoffRun / 10) * 10, better: -1 },
  { key: 'landing', label: 'Easy landing', bar: (s) => s.landing, text: (s) => `stall ${Math.round(s.stall * 3.6)} km/h`, delta: (s) => Math.round(s.landing * 10), better: 1 },
];

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class Hangar {
  private cat = 0;
  private stats: LoadoutStats;
  private bars: { fill: HTMLElement; val: HTMLElement; delta: HTMLElement; timer: number }[] = [];

  constructor(
    readonly loadout: Loadout,
    private onChange: (l: Loadout) => void,
    private onClick: () => void,
    private active: () => boolean,
  ) {
    this.stats = loadoutStats(composeSpec(loadout));
    const tabs = $('hangar-tabs');
    CATS.forEach((c, i) => {
      const b = document.createElement('button');
      b.textContent = c.label;
      b.addEventListener('click', () => {
        this.onClick();
        this.setCat(i);
      });
      tabs.append(b);
    });
    const st = $('hangar-stats');
    for (const row of STATS) {
      const r = document.createElement('div');
      r.className = 'stat';
      r.innerHTML = `<span class="stat-label">${row.label}</span><span class="stat-bar"><i></i></span><span class="stat-val"></span><span class="stat-delta"></span>`;
      st.append(r);
      this.bars.push({ fill: r.querySelector('i')!, val: r.querySelector('.stat-val')!, delta: r.querySelector('.stat-delta')!, timer: 0 });
    }
    window.addEventListener('keydown', (e) => {
      if (!this.active() || e.target instanceof HTMLInputElement || e.repeat) return;
      const k = e.code;
      if (k === 'ArrowLeft' || k === 'KeyA') this.nav(-1, 0);
      else if (k === 'ArrowRight' || k === 'KeyD') this.nav(1, 0);
      else if (k === 'ArrowUp' || k === 'KeyW') this.nav(0, -1);
      else if (k === 'ArrowDown' || k === 'KeyS') this.nav(0, 1);
    });
    this.setCat(0);
    this.refreshStats(false);
  }

  /** dx: switch category; dy: move through the options. */
  nav(dx: number, dy: number) {
    if (dx) {
      this.onClick();
      this.setCat((this.cat + dx + CATS.length) % CATS.length);
    }
    if (dy) {
      const c = CATS[this.cat].id;
      const opts = OPTIONS[c];
      const i = opts.findIndex((o) => o.id === this.loadout[c]);
      this.choose(c, opts[(i + dy + opts.length) % opts.length].id);
    }
  }

  private setCat(i: number) {
    this.cat = i;
    $('hangar-tabs')
      .querySelectorAll('button')
      .forEach((b, k) => b.classList.toggle('on', k === i));
    this.renderCards();
  }

  private renderCards() {
    const c = CATS[this.cat].id;
    const box = $('hangar-cards');
    box.className = c === 'paint' ? 'cards swatches' : 'cards';
    box.innerHTML = '';
    for (const o of OPTIONS[c]) {
      const b = document.createElement('button');
      b.className = 'card';
      b.classList.toggle('on', this.loadout[c] === o.id);
      if (o.swatch) {
        b.innerHTML = `<span class="swatch"></span><span class="card-name"></span>`;
        (b.querySelector('.swatch') as HTMLElement).style.background = o.swatch;
      } else {
        b.innerHTML = `<span class="card-icon"></span><span class="card-text"><span class="card-name"></span><span class="card-trait"></span></span>`;
        b.querySelector('.card-icon')!.textContent = o.icon ?? '';
        b.querySelector('.card-trait')!.textContent = o.trait ?? '';
      }
      b.querySelector('.card-name')!.textContent = o.name;
      b.title = o.trait ?? o.name;
      b.addEventListener('click', () => this.choose(c, o.id));
      box.append(b);
    }
    $('hangar-name').textContent = describeLoadout(this.loadout);
  }

  private choose(c: Cat, id: string) {
    if (this.loadout[c] === id) return;
    this.onClick();
    (this.loadout as unknown as Record<string, string>)[c] = id;
    saveLoadout(this.loadout);
    this.renderCards();
    this.refreshStats(true);
    this.onChange(this.loadout);
  }

  private refreshStats(showDelta: boolean) {
    const prev = this.stats;
    const next = loadoutStats(composeSpec(this.loadout));
    this.stats = next;
    STATS.forEach((row, i) => {
      const b = this.bars[i];
      b.fill.style.width = `${Math.round(row.bar(next) * 100)}%`;
      b.val.textContent = row.text(next);
      const d = row.delta(next) - row.delta(prev);
      if (showDelta && Math.abs(d) > 1e-6) {
        const good = d * row.better > 0;
        b.delta.textContent = `${d > 0 ? '+' : '−'}${Math.abs(Math.round(d * 10) / 10)}`;
        b.delta.className = `stat-delta show ${good ? 'up' : 'down'}`;
        clearTimeout(b.timer);
        b.timer = window.setTimeout(() => (b.delta.className = 'stat-delta'), 1600);
      }
    });
  }
}
