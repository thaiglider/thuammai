import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function copyStatic(): Plugin {
  return {
    name: 'thuammai-copy-static-and-sw',
    apply: 'build',
    closeBundle() {
      const out = resolve(ROOT, 'dist/static');
      mkdirSync(out, { recursive: true });
      for (const f of ['gazetteer.json', 'provinces.json']) copyFileSync(resolve(ROOT, 'static', f), resolve(out, f));
      writeServiceWorker(resolve(ROOT, 'dist'));
    },
  };
}

/** Fill the service worker's precache list and build id (see src/web/public/sw.js). Runs after
 *  static/ is copied, so everything listed exists. The build id hashes the contents of every
 *  precached file, so any change to the shell gives the worker a new cache name. The gazetteer
 *  (~440 KB) is deliberately not precached: it is cached on first use of the search box. */
function writeServiceWorker(dist: string): void {
  const assets = readdirSync(resolve(dist, 'assets')).sort().map((f) => `assets/${f}`);
  const files = ['index.html', ...assets, 'manifest.webmanifest', 'icon.svg', 'static/provinces.json'];
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update(readFileSync(resolve(dist, f)));
  const swPath = resolve(dist, 'sw.js');
  const sw = readFileSync(swPath, 'utf8');
  hash.update(sw);
  const precache = ['./', ...files];
  const out = sw
    .replace(/^const BUILD = .*; \/\/ @build$/m, `const BUILD = '${hash.digest('hex').slice(0, 12)}';`)
    .replace(/^const PRECACHE = .*; \/\/ @precache$/m, `const PRECACHE = ${JSON.stringify(precache)};`);
  if (out.includes('@build') || out.includes('@precache')) throw new Error('sw.js placeholders not found');
  writeFileSync(swPath, out);
}

export default defineConfig({
  root: 'src/web',
  base: './',
  publicDir: 'public',
  build: { outDir: '../../dist', emptyOutDir: true, target: 'es2022', sourcemap: false },
  preview: { port: 4173, strictPort: true },
  plugins: [copyStatic()],
});
