// Bundles the server's TypeScript (src/core, src/alerts and server/src) into server/dist/*.mjs.
// Dependencies (pg, web-push) stay external and load from node_modules at runtime (F1-14).
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('server/dist', { recursive: true, force: true });
await build({
  entryPoints: {
    api: 'server/src/bin/api.ts',
    alerts: 'server/src/bin/alerts.ts',
    migrate: 'server/src/bin/migrate.ts',
    'tools/keys': 'server/src/tools/keys.ts',
    'tools/telegram': 'server/src/tools/telegram.ts',
    'tools/health': 'server/src/tools/health.ts',
    'tools/kuma': 'server/src/tools/kuma.ts',
    'tools/admin': 'server/src/tools/admin.ts',
    'tools/line': 'server/src/tools/line.ts',
  },
  outdir: 'server/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
