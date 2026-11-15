/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheVersion, precacheList, serviceWorkerSource } from '../src/pwa/precache';

/** PWA install & offline test, unit part (design §10). */
const root = resolve(__dirname, '..');

describe('service worker precache', () => {
  const bundle = ['index.html', 'assets/index-abc.js', 'assets/index-abc.css', 'assets/chunk.worker-xyz.js', 'assets/lil-gui-1.js', 'assets/index-abc.js.map'];
  const pub = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'manifest.webmanifest', 'og-image.png', '_headers'];
  const list = precacheList(bundle, pub);

  it('has the page, every built file (incl. the chunk worker), the manifest and the icons', () => {
    expect(list).toContain('/');
    for (const f of ['/assets/index-abc.js', '/assets/index-abc.css', '/assets/chunk.worker-xyz.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/favicon.svg'])
      expect(list).toContain(f);
  });

  it('skips index.html (served as /), source maps, the share image and host config', () => {
    for (const f of ['/index.html', '/assets/index-abc.js.map', '/og-image.png', '/_headers', '/sw.js']) expect(list).not.toContain(f);
  });

  it('is sorted and has no duplicates', () => {
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
  });

  it('versions change when any file changes', () => {
    expect(cacheVersion(list, ['a', 'b'])).toBe(cacheVersion(list, ['a', 'b']));
    expect(cacheVersion(list, ['a', 'b'])).not.toBe(cacheVersion(list, ['a', 'c']));
    expect(cacheVersion(list, ['a'])).not.toBe(cacheVersion([...list, '/new.js'], ['a']));
  });

  it('fills the real template', () => {
    const tpl = readFileSync(resolve(root, 'src/pwa/sw.template.js'), 'utf8');
    const src = serviceWorkerSource(tpl, list, 'v123');
    expect(src).not.toContain('__VERSION__');
    expect(src).not.toContain('__PRECACHE__');
    expect(src).toContain('const VERSION = "v123"');
    expect(src).toContain('"/assets/chunk.worker-xyz.js"');
    expect(() => new Function(src)).not.toThrow(); // valid JavaScript
    expect(() => serviceWorkerSource('nothing here', list, 'v')).toThrow();
  });
});

describe('web app manifest', () => {
  const m = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8'));
  it('has what browsers need to offer installation', () => {
    expect(m.id).toBe('/');
    expect(m.start_url).toBe('/');
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBe('Baron');
    expect(['fullscreen', 'standalone']).toContain(m.display);
    const icons = m.icons as { src: string; sizes: string; purpose: string }[];
    expect(icons.some((i) => i.sizes === '192x192' && i.purpose.includes('any'))).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose.includes('any'))).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose.includes('maskable'))).toBe(true);
  });
  it('every icon file exists with the stated size', () => {
    for (const i of m.icons as { src: string; sizes: string; type: string }[]) {
      const buf = readFileSync(resolve(root, 'public', i.src.slice(1)));
      if (i.type !== 'image/png') continue;
      // PNG IHDR: width and height at bytes 16..24
      const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
      expect(`${w}x${h}`).toBe(i.sizes);
    }
  });
});
