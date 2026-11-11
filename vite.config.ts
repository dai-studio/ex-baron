import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

export default defineConfig({
  plugins: [devShots()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  server: { port: 5288 },
});
