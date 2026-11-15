/// <reference types="node" />
import { createHash } from 'node:crypto';

/**
 * Build-time helpers for the service worker (design §10, plan step 40). Used by the
 * Vite plugin in vite.config.ts; pure so the precache list can be unit-tested.
 */

/** Public files the app never needs offline (big share image, host config, the worker itself). */
const SKIP = new Set(['_headers', '_redirects', 'og-image.png', 'sw.js', '404.html']);

/**
 * URLs to precache: '/' for the page, every emitted bundle file and every public file,
 * minus the skips and source maps. Sorted so the version hash is stable.
 */
export function precacheList(bundleFiles: string[], publicFiles: string[]): string[] {
  const urls = new Set<string>(['/']);
  for (const f of [...bundleFiles, ...publicFiles]) {
    const name = f.replace(/\\/g, '/').replace(/^\//, '');
    if (name === 'index.html' || SKIP.has(name) || name.endsWith('.map') || name.startsWith('.')) continue;
    urls.add(`/${name}`);
  }
  return [...urls].sort();
}

/** Short hash of the list and the file contents: changes on every deploy that changes anything. */
export function cacheVersion(list: string[], contents: (string | Uint8Array)[]): string {
  const h = createHash('sha256');
  for (const u of list) h.update(u);
  for (const c of contents) h.update(c);
  return h.digest('hex').slice(0, 12);
}

/** Fill the template's VERSION and PRECACHE placeholder lines. */
export function serviceWorkerSource(template: string, list: string[], version: string): string {
  const v = 'const VERSION = __VERSION__;';
  const p = 'const PRECACHE = __PRECACHE__;';
  if (!template.includes(v) || !template.includes(p)) throw new Error('sw template is missing its placeholders');
  return template.replace(v, `const VERSION = ${JSON.stringify(version)};`).replace(p, `const PRECACHE = ${JSON.stringify(list)};`);
}
