/** Settings & saves in localStorage (design §6 "Settings & saves"). */
export type Quality = 'auto' | 'low' | 'medium' | 'high';
export type Assist = 'arcade' | 'normal' | 'expert';

export interface Settings {
  quality: Quality;
  assist: Assist;
  seed: number;
  volume: number;
  invertPitch: boolean;
  cameraShake: boolean;
}

export interface BestRecord {
  medal: number; // 0 none, 1 bronze, 2 silver, 3 gold
  landing: string;
}

const KEY = 'baron.settings.v1';
const BEST_KEY = 'baron.best.v1';

export function randomSeed(): number {
  return Math.floor(Math.random() * 999_999_999) + 1;
}

export function defaultSettings(): Settings {
  return {
    quality: 'auto',
    assist: 'arcade',
    seed: randomSeed(),
    volume: 0.7,
    invertPitch: false,
    cameraShake: true,
  };
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode etc.) — settings just won't persist */
  }
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  const raw = safeGet(KEY);
  if (!raw) return d;
  try {
    const s = JSON.parse(raw) as Partial<Settings> & { mission?: unknown; difficulty?: unknown };
    delete s.mission; // removed with the Dogfight mission
    delete s.difficulty;
    return { ...d, ...s };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings) {
  safeSet(KEY, JSON.stringify(s));
}

function loadBest(): Record<string, BestRecord> {
  const raw = safeGet(BEST_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, BestRecord>;
  } catch {
    return {};
  }
}

export function getBest(seed: number): BestRecord | null {
  return loadBest()[`free:${seed}`] ?? null;
}

/** Stores the record if it beats the previous best; returns true when it did. */
export function submitBest(seed: number, rec: BestRecord): boolean {
  const all = loadBest();
  const key = `free:${seed}`;
  const prev = all[key];
  if (prev && prev.medal >= rec.medal) return false;
  all[key] = rec;
  safeSet(BEST_KEY, JSON.stringify(all));
  return true;
}
