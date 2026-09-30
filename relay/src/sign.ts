import { gzipSync } from 'node:zlib';
import { relaySignature } from '../../src/core/relay-sig';
import type { RelayPayload } from '../../src/core/relay-types';
import { validCanal, validRoad } from '../../src/core/relay-validate';

export const MIN_ITEMS = 50;

/** Send only when road or canal is plausibly complete (spec §2). */
export function shouldSend(p: RelayPayload): boolean {
  return p.road.length >= MIN_ITEMS || p.canal.length >= MIN_ITEMS;
}

export function buildRequest(payload: RelayPayload, key: Buffer | string, nowSec: number): { body: Buffer; headers: Record<string, string> } {
  const body = gzipSync(Buffer.from(JSON.stringify(payload)));
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'x-relay-time': String(nowSec),
      'x-relay-sig': relaySignature(key, nowSec, body),
    },
  };
}

/** Short, safe reason for the payload `error` field: no URLs, single line, <= 200 chars. */
export function shortError(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** What to POST: the payload when complete enough, else an empty payload carrying only the error (still signed). */
export function toSend(p: RelayPayload): { payload: RelayPayload; failed: boolean } {
  if (shouldSend(p)) return { payload: p.error ? { ...p, error: shortError(p.error) } : p, failed: false };
  const error = shortError(p.error || `too few items (road=${p.road.length}, canal=${p.canal.length})`);
  return { payload: { v: 1, fetchedAt: p.fetchedAt, road: [], canal: [], error }, failed: true };
}

/** Drop items flood-api would refuse (it rejects a whole report over one bad item); returns the count only. */
export function dropInvalid(p: RelayPayload): { payload: RelayPayload; dropped: number } {
  const road = p.road.filter(validRoad);
  const canal = p.canal.filter(validCanal);
  return { payload: { ...p, road, canal }, dropped: p.road.length - road.length + p.canal.length - canal.length };
}
