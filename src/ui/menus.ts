import { getBest, randomSeed, saveSettings, type Settings } from '../core/settings';

/** Title/hangar, loading, pause and debrief screens (design §2, §3 HUD & UI). */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface MenuHandlers {
  fly(): void;
  resume(): void;
  restart(): void;
  quit(): void;
  again(): void;
  newWorld(): void;
  seedChanged(seed: number): void;
  qualityChanged(): void;
  volumeChanged(v: number): void;
  click(): void;
}

export interface DebriefData {
  title: string;
  medal: number;
  rows: [string, string][];
  newBest: boolean;
}

const MEDALS = ['🎈', '🥉', '🥈', '🥇'];

export class Menus {
  private toastTimer = 0;
  private hintTimer = 0;

  constructor(
    private settings: Settings,
    private h: MenuHandlers,
  ) {
    this.bindSeg('mission-seg', () => settings.mission, (v) => (settings.mission = v as Settings['mission']));
    this.bindSeg('difficulty-seg', () => settings.difficulty, (v) => (settings.difficulty = v as Settings['difficulty']));
    this.bindSeg('assist-seg', () => settings.assist, (v) => (settings.assist = v as Settings['assist']));
    this.bindSeg('quality-seg', () => settings.quality, (v) => {
      settings.quality = v as Settings['quality'];
      h.qualityChanged();
    });

    const seedInput = $<HTMLInputElement>('seed-input');
    seedInput.value = String(settings.seed);
    seedInput.addEventListener('change', () => {
      const v = parseInt(seedInput.value.replace(/\D/g, ''), 10);
      if (Number.isFinite(v) && v > 0) {
        settings.seed = v;
        saveSettings(settings);
        h.seedChanged(v);
      } else seedInput.value = String(settings.seed);
      this.refreshBest();
    });
    $('seed-roll').addEventListener('click', () => {
      h.click();
      settings.seed = randomSeed();
      seedInput.value = String(settings.seed);
      saveSettings(settings);
      h.seedChanged(settings.seed);
      this.refreshBest();
    });

    $('fly-btn').addEventListener('click', () => h.fly());
    $('resume-btn').addEventListener('click', () => h.resume());
    $('restart-btn').addEventListener('click', () => h.restart());
    $('quit-btn').addEventListener('click', () => h.quit());
    $('again-btn').addEventListener('click', () => h.again());
    $('newworld-btn').addEventListener('click', () => h.newWorld());
    $('hangar-btn').addEventListener('click', () => h.quit());

    const vol = $<HTMLInputElement>('volume');
    vol.value = String(settings.volume);
    vol.addEventListener('input', () => {
      settings.volume = parseFloat(vol.value);
      saveSettings(settings);
      h.volumeChanged(settings.volume);
    });
    const shake = $<HTMLInputElement>('shake');
    shake.checked = settings.cameraShake;
    shake.addEventListener('change', () => {
      settings.cameraShake = shake.checked;
      saveSettings(settings);
    });
    const inv = $<HTMLInputElement>('invert');
    inv.checked = settings.invertPitch;
    inv.addEventListener('change', () => {
      settings.invertPitch = inv.checked;
      saveSettings(settings);
    });
    this.refreshBest();
  }

  private bindSeg(id: string, get: () => string, set: (v: string) => void) {
    const el = $(id);
    const buttons = Array.from(el.querySelectorAll('button'));
    const sync = () => buttons.forEach((b) => b.classList.toggle('on', b.dataset.v === get()));
    buttons.forEach((b) =>
      b.addEventListener('click', () => {
        set(b.dataset.v!);
        saveSettings(this.settings);
        this.h.click();
        sync();
        this.refreshBest();
      }),
    );
    sync();
  }

  refreshBest() {
    const b = getBest(this.settings.seed, this.settings.mission);
    $('best-line').textContent = b ? `Best on this world: ${MEDALS[b.medal]} ${b.kills} kills, landing ${b.landing}` : '';
  }

  setSeed(seed: number) {
    $<HTMLInputElement>('seed-input').value = String(seed);
    this.refreshBest();
  }

  show(screen: 'title' | 'loading' | 'pause' | 'debrief' | 'nogl' | 'ctxlost' | 'none') {
    for (const id of ['title', 'loading', 'pause', 'debrief', 'nogl', 'ctxlost']) $(id).classList.toggle('hidden', id !== screen);
  }

  setLoading(f: number) {
    $('load-bar').style.width = `${Math.round(f * 100)}%`;
  }

  showDebrief(d: DebriefData) {
    $('debrief-title').textContent = d.title;
    $('medal').textContent = MEDALS[d.medal];
    const t = $('debrief-stats');
    t.innerHTML = '';
    for (const [k, v] of d.rows) {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      a.textContent = k;
      const b = document.createElement('td');
      b.textContent = v;
      tr.append(a, b);
      t.append(tr);
    }
    if (d.newBest) {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      a.colSpan = 2;
      a.style.textAlign = 'center';
      a.textContent = '★ New best for this world! ★';
      tr.append(a);
      t.append(tr);
    }
    this.show('debrief');
  }

  toast(text: string, ms = 1600) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
  }

  hint(text: string, ms = 4500) {
    const el = $('hint');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => el.classList.remove('show'), ms);
  }

  clearHint() {
    $('hint').classList.remove('show');
  }

  setWhiteout(v: number) {
    $('whiteout').style.opacity = String(v);
  }

  setHurt(v: number) {
    $('hurt').style.opacity = String(v);
  }
}
