import { readFileSync } from 'node:fs';
import { toIso07 } from '../../src/core/time';
import type { RelayPayload } from '../../src/core/relay-types';
import { fetchCanal, fetchRoad } from './fetch';
import { parseCanal, parseRoad } from './parse';
import { buildRequest, dropInvalid, toSend } from './sign';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(s);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One request at a time, >= 2 s apart; each source may fail alone. */
async function collect(now: Date): Promise<{ payload: RelayPayload; errors: string[] }> {
  const errors: string[] = [];
  let road: RelayPayload['road'] = [];
  let canal: RelayPayload['canal'] = [];
  try {
    road = parseRoad(await fetchRoad(now), now);
  } catch (e) {
    errors.push(`road: ${msg(e)}`);
  }
  await sleep(2000);
  try {
    canal = parseCanal(await fetchCanal(), now);
  } catch (e) {
    errors.push(`canal: ${msg(e)}`);
  }
  const payload: RelayPayload = { v: 1, fetchedAt: toIso07(now), road, canal };
  if (errors.length) payload.error = errors.join('; ');
  return { payload, errors };
}

async function main(): Promise<number> {
  const once = process.argv.includes('--once');
  const collected = await collect(new Date());
  const errors = collected.errors;
  // Items outside flood-api's bounds would get the whole report refused: drop them here, count only.
  const { payload, dropped } = dropInvalid(collected.payload);
  if (dropped > 0) log(`dropped ${dropped} invalid item(s)`);
  log(`fetched road=${payload.road.length} canal=${payload.canal.length}${errors.length ? ` errors=${errors.length}` : ''}`);
  for (const e of errors) log(`warn ${e}`);
  const { payload: out, failed } = toSend(payload);
  if (once) {
    log(failed ? '--once: too few items (road<50 and canal<50); dry run, not sending' : '--once: dry run, not sending');
    return failed ? 1 : 0;
  }
  const url = process.env.RELAY_URL;
  const keyFile = process.env.RELAY_KEY_FILE;
  if (!url || !keyFile) throw new Error('RELAY_URL and RELAY_KEY_FILE are required');
  const key = readFileSync(keyFile, 'utf8').trim();
  if (!key) throw new Error('empty key file');
  const { body, headers } = buildRequest(out, key, Math.floor(Date.now() / 1000));
  const res = await fetch(url, { method: 'POST', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    log(`post failed: HTTP ${res.status}`);
    return 1;
  }
  log(`posted ${body.length} bytes gzip: HTTP ${res.status}${failed ? ' (error report)' : ''}`);
  if (failed) return 1;
  const kuma = process.env.KUMA_PUSH_URL;
  if (kuma) {
    try {
      await fetch(kuma, { signal: AbortSignal.timeout(10_000) });
    } catch {
      log('warn kuma push failed');
    }
  }
  return 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    log(`error: ${msg(e)}`);
    process.exit(1);
  },
);
