import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ProvinceGeo } from '../../../src/core/types';

export const META_MAX = 256 * 1024;
export const FILE_MAX = 20 * 1024 * 1024;
/** All files of one snapshot together (final review M3): the tmpfs is 128 MiB and loadSnapshot
 *  parses every file into a 384 MB heap; a real snapshot is about 4 MB. */
export const TOTAL_MAX = 64 * 1024 * 1024;
export const TOTAL_MS = 60_000;
export const CONCURRENCY = 8;
/** A Pages gen later than this past our clock is not trusted (a clock or publish error): counted
 *  as `gen_future`, never downloaded or run. */
export const FUTURE_MAX_MS = 5 * 60_000;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

class FetchFailed extends Error { constructor() { super('fetch failed'); this.name = 'FetchFailed'; } }
class TooBig extends Error { constructor() { super('snapshot too big'); this.name = 'TooBig'; } }
/** Bytes charged so far across the files of one download. */
interface Budget { used: number; max: number }

/** One response body chunk by chunk, refusing more than `max` bytes (declared or streamed), and
 *  — with a `total` budget — more than the budget over all files (declared or streamed). */
async function streamBody(url: string, fetchImpl: typeof fetch, max: number, signal: AbortSignal, onChunk: (b: Uint8Array) => void, total?: Budget): Promise<void> {
  const r = await fetchImpl(url, { signal, headers: { accept: 'application/json' } });
  if (!r.ok || !r.body) { await r.body?.cancel().catch(() => undefined); throw new FetchFailed(); }
  const len = r.headers.get('content-length');
  if (len !== null && Number(len) > max) { await r.body.cancel().catch(() => undefined); throw new FetchFailed(); }
  // A declared length is charged up front; streamed bytes beyond it are charged as they come.
  let charged = len !== null && Number.isFinite(Number(len)) ? Number(len) : 0;
  if (total) {
    total.used += charged;
    if (total.used > total.max) { await r.body.cancel().catch(() => undefined); throw new TooBig(); }
  }
  const reader = r.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => undefined); throw new FetchFailed(); }
    if (total && n > charged) {
      total.used += n - charged;
      charged = n;
      if (total.used > total.max) { await reader.cancel().catch(() => undefined); throw new TooBig(); }
    }
    try { onChunk(value); } catch (e) { await reader.cancel().catch(() => undefined); throw e; }
  }
}

async function bodyText(url: string, fetchImpl: typeof fetch, max: number, signal: AbortSignal): Promise<string> {
  const parts: Uint8Array[] = [];
  await streamBody(url, fetchImpl, max, signal, (b) => parts.push(b));
  return Buffer.concat(parts).toString('utf8');
}

/** Raw bytes straight to the file (no text conversion, nothing held in memory): 8 lanes × 20 MB
 *  must never sit in the heap at once (512 MiB container limit). */
async function bodyToFile(url: string, fetchImpl: typeof fetch, max: number, signal: AbortSignal, path: string, total: Budget): Promise<void> {
  const fd = openSync(path, 'w');
  try {
    await streamBody(url, fetchImpl, max, signal, (b) => { for (let off = 0; off < b.byteLength;) off += writeSync(fd, b, off); }, total);
  } finally {
    closeSync(fd);
  }
}

/** true when `gen` lies more than FUTURE_MAX_MS after `nowMs`. */
export const genInFuture = (gen: string, nowMs: number): boolean => Date.parse(gen) - nowMs > FUTURE_MAX_MS;

/** meta.generatedAt of the published site, with `?t=` past any CDN cache (R27); null on any failure. */
export async function fetchMetaGen(siteUrl: string, fetchImpl: typeof fetch, t: number, timeoutMs = 10_000): Promise<string | null> {
  try {
    const j = JSON.parse(await bodyText(new URL(`data/meta.json?t=${t}`, siteUrl).href, fetchImpl, META_MAX, AbortSignal.timeout(timeoutMs))) as unknown;
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
    const gen = (j as { generatedAt?: unknown }).generatedAt;
    // Never trusted blindly: only an ISO timestamp is compared, logged as a flag or used as a gen.
    return typeof gen === 'string' && ISO_RE.test(gen) && Number.isFinite(Date.parse(gen)) ? gen : null;
  } catch {
    return null;
  }
}

export const snapshotFiles = (provinces: ProvinceGeo[]): string[] => ['meta.json', 'events.json', 'forecast.json', ...provinces.map((p) => `obs/${p.code}.json`)];

export type DownloadResult = 'ok' | 'failed' | 'too_big';

/** Every file loadSnapshot reads, all with the same `?t=` (so the CDN cannot mix runs silently —
 *  loadSnapshot still detects a mix), ≤8 in parallel, ≤20 MB each, ≤64 MB together ('too_big'),
 *  ≤60 s in total (spec §4.3). */
export async function downloadSnapshot(siteUrl: string, provinces: ProvinceGeo[], fetchImpl: typeof fetch, dir: string, t: number): Promise<DownloadResult> {
  mkdirSync(join(dir, 'obs'), { recursive: true });
  const files = snapshotFiles(provinces);
  // One failure ends the whole download: the rest is useless and is fetched again next tick.
  const failed = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(TOTAL_MS), failed.signal]);
  const total: Budget = { used: 0, max: TOTAL_MAX };
  let next = 0;
  let ok = true;
  let tooBig = false;
  const lane = async (): Promise<void> => {
    while (ok && next < files.length) {
      const f = files[next++]!;
      try {
        await bodyToFile(new URL(`data/${f}?t=${t}`, siteUrl).href, fetchImpl, FILE_MAX, signal, join(dir, f), total);
      } catch (e) {
        if (e instanceof TooBig) tooBig = true;
        ok = false;
        failed.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  return tooBig ? 'too_big' : ok ? 'ok' : 'failed';
}
