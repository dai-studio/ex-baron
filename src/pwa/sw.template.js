/* Baron service worker (design §10). Generated at build time from src/pwa/sw.template.js:
   the build plugin fills in VERSION and PRECACHE. Never registered in `vite dev`. */
const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;
const CACHE = `baron-${VERSION}`;
const FONTS = 'baron-fonts';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
/** a slow network shouldn't hold up the start: fall back to the cached page after this */
const NAV_TIMEOUT = 3000;

self.addEventListener('install', (e) => {
  // every built file, so the app starts offline even if the first visit didn't load them all;
  // cache: 'reload' skips the HTTP cache so a deploy never mixes old and new files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('baron-') && k !== CACHE && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// the page asks for this from the menu ('New version ready — Restart'), never mid-flight
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req, FONTS));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(navigation(req));
    return;
  }
  e.respondWith(
    // ignoreVary: servers send 'Vary: Origin' and module scripts carry an Origin header the
    // precache requests didn't, which made every offline lookup miss (found in testing)
    caches.match(req, { cacheName: CACHE, ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          // hashed build files never change: keep any the precache missed
          if (res.ok && url.pathname.startsWith('/assets/')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

/** Network first (so a deploy shows up), the cached page when offline or slow. */
async function navigation(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT)),
    ]);
    // one page: every navigation (?plane=…, ?debug) is the same document
    if (res.ok) cache.put('/', res.clone());
    return res;
  } catch {
    return (await cache.match('/', { ignoreVary: true })) || Response.error();
  }
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || fresh;
}
