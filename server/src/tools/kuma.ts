import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { kumaPush } from '../alerts/kuma';

/** CLI wrapper around kumaPush (spec F2-K): run inside the "tools" compose service (profile
 *  tools), which is the only container besides "alerts" on the shared ai-stack_ai-stack network.
 *  bin/update.sh, bin/backup.sh and bin/hostcheck.sh call it as
 *  `docker compose run --rm tools node dist/tools/kuma.mjs <push-url-file> up|down [msg]` — never a
 *  host curl (the push URL is a secret and Kuma's public URL answers an auth redirect that a plain
 *  curl would treat as success). The push URL file may be empty (Kuma push not configured yet): that
 *  is not a failure, so the caller's own monitor stays quiet instead of alerting on setup order.
 *  Usage: kuma.mjs <push-url-file> up|down [msg] */
export async function kumaCli(argv: string[], readFileImpl: (p: string) => string, fetchImpl: typeof fetch): Promise<{ code: number; word: string }> {
  const [urlFile, status, msg = ''] = argv;
  if (!urlFile || (status !== 'up' && status !== 'down')) return { code: 2, word: 'usage: kuma.mjs <push-url-file> up|down [msg]' };
  let url: string;
  try {
    url = readFileImpl(urlFile).trim();
  } catch {
    url = '';
  }
  if (!url) return { code: 0, word: 'skipped' };
  const ok = await kumaPush(url, status, msg, fetchImpl);
  return { code: ok ? 0 : 1, word: ok ? 'ok' : 'kuma_failed' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  kumaCli(process.argv.slice(2), (p) => readFileSync(p, 'utf8'), fetch).then((r) => {
    console.log(r.word);
    process.exit(r.code);
  });
}
