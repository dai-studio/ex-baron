/**
 * Device helpers for mobile support (design §9): touch detection from the input
 * the device offers (never the user agent), safe-area insets, fullscreen,
 * orientation lock and the screen wake lock. Every call fails silently.
 */
export interface Insets {
  l: number;
  r: number;
  t: number;
  b: number;
}

const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;

/** The primary pointer is a finger (phones, tablets). */
export function coarsePointer(): boolean {
  return mq('(pointer: coarse)');
}

/** A phone or small tablet: coarse pointer and a short side ≤ 900 CSS px. */
export function smallTouchScreen(): boolean {
  return coarsePointer() && Math.min(screen.width, screen.height) <= 900;
}

let probe: HTMLDivElement | null = null;

/** env(safe-area-inset-*) in CSS px (notch, rounded corners, home bar). */
export function safeInsets(): Insets {
  if (typeof document === 'undefined') return { l: 0, r: 0, t: 0, b: 0 };
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(probe);
  }
  const cs = getComputedStyle(probe);
  const px = (v: string) => parseFloat(v) || 0;
  return { l: px(cs.paddingLeft), r: px(cs.paddingRight), t: px(cs.paddingTop), b: px(cs.paddingBottom) };
}

/** Fullscreen + landscape lock (Android Chrome). Must be called from a user gesture. */
export function enterGameFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      return o?.lock?.('landscape');
    })
    .catch(() => {
      /* not allowed or not supported (iPhone): the rotate card and the home-screen app cover it */
    });
}

/** Screen wake lock while flying, so a long cross-country doesn't dim the screen. */
export class WakeLock {
  private lock: { release(): Promise<void> } | null = null;
  private want = false;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.want && !this.lock) this.acquire();
    });
  }

  set(on: boolean) {
    this.want = on;
    if (on && !this.lock) this.acquire();
    if (!on && this.lock) {
      void this.lock.release().catch(() => {});
      this.lock = null;
    }
  }

  private acquire() {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void>; addEventListener(e: string, f: () => void): void }> } }).wakeLock;
    if (!wl || document.hidden) return;
    wl.request('screen')
      .then((l) => {
        if (!this.want) {
          void l.release();
          return;
        }
        this.lock = l;
        l.addEventListener('release', () => {
          if (this.lock === l) this.lock = null;
        });
      })
      .catch(() => {});
  }
}
