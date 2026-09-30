// Bundles the relay into one file: relay/dist/relay.mjs (no runtime dependencies; Node 24).
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('relay/dist', { recursive: true, force: true });
await build({
  entryPoints: { relay: 'relay/src/main.ts' },
  outdir: 'relay/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
