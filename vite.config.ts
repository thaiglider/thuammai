import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { alertsOriginForBuild, cspForBuild, publicOriginForBuild, swWithAlerts } from './src/build/csp.ts';
import { precacheAssets, type ViteManifest } from './src/build/precache.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function copyStatic(alertsOrigin: string): Plugin {
  return {
    name: 'thuammai-copy-static-and-sw',
    apply: 'build',
    closeBundle() {
      const out = resolve(ROOT, 'dist/static');
      mkdirSync(out, { recursive: true });
      for (const f of ['gazetteer.json', 'provinces.json']) copyFileSync(resolve(ROOT, 'static', f), resolve(out, f));
      // MapLibre is BSD-3-Clause: redistributing it in the map chunk requires its notice.
      const lic = resolve(ROOT, 'dist/licenses');
      mkdirSync(lic, { recursive: true });
      copyFileSync(resolve(ROOT, 'node_modules/maplibre-gl/LICENSE.txt'), resolve(lic, 'maplibre-gl.txt'));
      writeServiceWorker(resolve(ROOT, 'dist'), alertsOrigin);
    },
  };
}

/** Fill the service worker's precache list and build id (see src/web/public/sw.js). Runs after
 *  static/ is copied, so everything listed exists. precached files = entry closure from the Vite
 *  manifest (see src/build/precache.ts). The build id hashes the contents of every precached
 *  file, so any change to the shell gives the worker a new cache name. The gazetteer (~440 KB) is
 *  deliberately not precached: it is cached on first use of the search box. */
function writeServiceWorker(dist: string, alertsOrigin: string): void {
  const manifest = JSON.parse(readFileSync(resolve(dist, '.vite/manifest.json'), 'utf8')) as ViteManifest;
  const all = readdirSync(resolve(dist, 'assets')).sort().map((f) => `assets/${f}`);
  // Only what the first page needs (entry JS/CSS and fonts). Lazy chunks — the map (MapLibre and
  // its worker, ~0.5 MB) and the QR code — are cached on first use, so installing the worker
  // never downloads the map for people who never open it.
  const assets = precacheAssets(manifest, 'index.html', all);
  const files = ['index.html', ...assets, 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'static/provinces.json'];
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
  writeFileSync(swPath, swWithAlerts(out, alertsOrigin));
}

/** Adds the alerts server (spec §6.6) and the public origin (Plan I move check) to the page CSP. */
function connectCsp(alertsOrigin: string, publicOrigin: string): Plugin {
  return { name: 'thuammai-connect-csp', transformIndexHtml: (html) => cspForBuild(html, alertsOrigin, publicOrigin) };
}

export default defineConfig(({ mode }) => {
  // The e2e settings (test origin, dummy key) live with the tests, outside the published src/ (m9).
  const envDir = resolve(ROOT, mode === 'e2e' ? 'tests/e2e' : 'src/web');
  const raw = loadEnv(mode, envDir, 'VITE_').VITE_ALERTS_ORIGIN;
  const publicOrigin = publicOriginForBuild(loadEnv(mode, envDir, 'VITE_').VITE_PUBLIC_ORIGIN); // throws (build fails) when malformed
  const { origin: alertsOrigin, warning } = alertsOriginForBuild(raw);
  if (warning) console.warn(`
[thuammai] WARNING: ${warning}
`);
  return {
    root: 'src/web',
    base: './',
    envDir,
    // An invalid origin is blanked for the page too, so the client sees alerts off.
    define: warning ? { 'import.meta.env.VITE_ALERTS_ORIGIN': JSON.stringify('') } : {},
    publicDir: 'public',
    build: { outDir: '../../dist', emptyOutDir: true, target: 'es2022', sourcemap: false, manifest: true },
    preview: { port: 4173, strictPort: true },
    plugins: [copyStatic(alertsOrigin), connectCsp(alertsOrigin, publicOrigin)],
  };
});
