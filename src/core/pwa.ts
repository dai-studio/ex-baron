/**
 * Installable app (design §10): registers the service worker (production builds only),
 * offers installation (Chrome / Edge 'beforeinstallprompt', an iOS Safari tip) and the
 * 'New version ready — Restart' update flow. All failures are silent: the game runs as a
 * normal web page without any of it.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const TIP_KEY = 'baron.iosTip.dismissed';

export class Pwa {
  /** called whenever canInstall / iosTip / updateReady change */
  onChange: (() => void) | null = null;
  private installEvent: InstallPromptEvent | null = null;
  private waiting: ServiceWorker | null = null;
  private tipDismissed = false;

  constructor() {
    try {
      this.tipDismissed = localStorage.getItem(TIP_KEY) === '1';
    } catch {
      /* storage blocked */
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // our own button on the menu instead of the browser's mini-bar
      this.installEvent = e as InstallPromptEvent;
      this.changed();
    });
    window.addEventListener('appinstalled', () => {
      this.installEvent = null;
      this.changed();
    });
  }

  /** Running as the installed app (its own window / home-screen launch). */
  get installed(): boolean {
    const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
    return mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)') || mq('(display-mode: minimal-ui)') || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  }

  /** The browser offers installation (Chrome, Edge, Android). */
  get canInstall(): boolean {
    return !!this.installEvent && !this.installed;
  }

  /** iPhone / iPad Safari: no install prompt exists, so show 'Share → Add to Home Screen'. */
  get iosTip(): boolean {
    if (this.installed || this.tipDismissed) return false;
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    return ios && safari;
  }

  /** A new version is downloaded and waiting for a restart. */
  get updateReady(): boolean {
    return !!this.waiting;
  }

  register() {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          const track = (w: ServiceWorker | null) => {
            if (!w) return;
            const check = () => {
              // 'installed' with a controller = an update (the very first install needs no restart)
              if (w.state === 'installed' && navigator.serviceWorker.controller) {
                this.waiting = w;
                this.changed();
              }
            };
            w.addEventListener('statechange', check);
            check();
          };
          // an update may already be waiting, or still installing when register() resolves
          track(reg.waiting);
          track(reg.installing);
          reg.addEventListener('updatefound', () => track(reg.installing));
          // long sessions: look for a new deploy when the app comes back to the front
          document.addEventListener('visibilitychange', () => {
            if (!document.hidden) void reg.update().catch(() => {});
          });
        })
        .catch(() => {
          /* no service worker (private mode, blocked): plain web page */
        });
    });
  }

  async install() {
    const e = this.installEvent;
    if (!e) return;
    this.installEvent = null;
    await e.prompt().catch(() => {});
    this.changed();
  }

  dismissTip() {
    this.tipDismissed = true;
    try {
      localStorage.setItem(TIP_KEY, '1');
    } catch {
      /* storage blocked */
    }
    this.changed();
  }

  /** Switch to the waiting version and reload (call from the menu only, never mid-flight). */
  restart() {
    const w = this.waiting;
    if (!w) return;
    let done = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (done) return;
      done = true;
      location.reload();
    });
    w.postMessage('skipWaiting');
  }

  private changed() {
    this.onChange?.();
  }
}
