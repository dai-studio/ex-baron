import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cacheVersion, precacheList, serviceWorkerSource } from './src/pwa/precache';

/**
 * Dev-only helper: POST a PNG data URL to /__shot?name=foo and it is saved to
 * .shots/foo.png. Used for visual checks during development; never built.
 */
function devShots(): Plugin {
  return {
    name: 'baron-dev-shots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const url = new URL(req.url ?? '', 'http://x');
          const name = (url.searchParams.get('name') ?? 'shot').replace(/[^\w-]/g, '');
          const body = Buffer.concat(chunks).toString();
          const b64 = body.replace(/^data:image\/png;base64,/, '');
          const dir = resolve(__dirname, '.shots');
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, `${name}.png`), Buffer.from(b64, 'base64'));
          res.end('ok');
        });
      });
    },
  };
}

/**
 * Build-only: emit dist/sw.js from src/pwa/sw.template.js with the list of every built and
 * public file to precache, and a version hash of their contents (design §10 Service worker).
 */
function serviceWorker(): Plugin {
  return {
    name: 'baron-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const pubDir = resolve(__dirname, 'public');
      const pub = readdirSync(pubDir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => resolve(d.parentPath, d.name).slice(pubDir.length + 1));
      const list = precacheList(Object.keys(bundle), pub);
      const template = readFileSync(resolve(__dirname, 'src/pwa/sw.template.js'), 'utf8');
      // the template is part of the version too: a change to the caching logic is a new version
      const contents = [template, ...Object.values(bundle).map((o) => (o.type === 'chunk' ? o.code : o.source))];
      for (const f of pub) contents.push(readFileSync(resolve(pubDir, f)));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(template, list, cacheVersion(list, contents)) });
    },
  };
}

export default defineConfig({
  plugins: [devShots(), serviceWorker()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  server: { port: 5288 },
});
