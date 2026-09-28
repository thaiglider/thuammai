import { parseDepthCm, sanitizeText } from '../../core/depth-text';
import { distKm, inThailand } from '../../core/geo';
import { EVENT_AGE_H, TRAFFY } from '../../core/thresholds';
import { isTooFarInFuture, parseUtc, toIso07 } from '../../core/time';
import type { FloodEvent } from '../../core/types';
import type { Fetcher } from '../fetcher';

export const TRAFFY_URL = 'https://publicapi.traffy.in.th/share/teamchadchart/search';
const FLOOD_RE = /ท่วม|น้ำขัง|น้ำรอระบาย|ระบายน้ำไม่ทัน/;
const NEG_RE = /น้ำลด|ประปา|ท่อแตก|รั่ว/;

const isFloodTicket = (r: any) => FLOOD_RE.test(String(r?.description ?? '')) && !NEG_RE.test(String(r?.description ?? ''));

export function parseTraffyResults(results: any[], now: Date): FloodEvent[] {
  const out: FloodEvent[] = [];
  const maxAgeMs = EVENT_AGE_H.traffy * 3600e3;
  for (const r of results) {
    if (!isFloodTicket(r) || r.state === 'เสร็จสิ้น' || !Array.isArray(r.coords)) continue;
    const lon = Number(r.coords[0]);
    const lat = Number(r.coords[1]);
    const t = parseUtc(r.timestamp);
    if (!t || isTooFarInFuture(t, now) || now.getTime() - t.getTime() > maxAgeMs || !inThailand(lat, lon)) continue;
    const text = String(r.description);
    out.push({
      id: `traffy:${r.ticket_id}`, source: 'traffy', reporter: 'traffy',
      lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, t: toIso07(t),
      title: sanitizeText(text), depthCm: parseDepthCm(text),
    });
  }
  return out;
}

export function dedupTraffy(events: FloodEvent[]): FloodEvent[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const kept: FloodEvent[] = [];
  const ids = new Set<string>();
  for (const e of sorted) {
    if (ids.has(e.id)) continue;
    const dup = kept.some((k) => distKm(k.lat, k.lon, e.lat, e.lon) * 1000 <= TRAFFY.dedupM
      && Math.abs(Date.parse(k.t) - Date.parse(e.t)) <= TRAFFY.dedupH * 3600e3);
    ids.add(e.id);
    if (!dup) kept.push(e);
  }
  return kept;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface TraffyOpts {
  /** Stop paging once this much wall-clock time has passed since the call started (default 90 s). */
  deadlineMs?: number;
  /** Monotonic-ish clock in ms (tests). */
  clock?: () => number;
}

export async function fetchTraffy(
  f: Fetcher, now: Date, prev: FloodEvent[], prevCoveredSince: string | undefined,
  sleep: (ms: number) => Promise<void> = defaultSleep, opts: TraffyOpts = {},
): Promise<{ events: FloodEvent[]; coveredSince: string }> {
  const clock = opts.clock ?? Date.now;
  const deadlineMs = opts.deadlineMs ?? TRAFFY.deadlineMs;
  const startedMs = clock();
  const cutoffMs = now.getTime() - EVENT_AGE_H.traffy * 3600e3;
  const known = new Set(prev.map((e) => e.id));
  const fresh: FloodEvent[] = [];
  let oldestSeenMs = now.getTime();
  let boundary: 'old' | 'known' | 'none' = 'none';
  for (let page = 0; page < TRAFFY.maxPages; page++) {
    if (page > 0) {
      if (clock() - startedMs >= deadlineMs) break; // out of time: same as reaching maxPages
      await sleep(TRAFFY.pauseMs);
    }
    const raw: any = await f.json(`${TRAFFY_URL}?limit=${TRAFFY.pageSize}&offset=${page * TRAFFY.pageSize}`);
    const results: any[] = raw?.results ?? [];
    if (!results.length) {
      // An empty first page is an outage symptom (the feed always has recent tickets) → carry forward.
      if (page === 0) throw new Error('traffy returned no results');
      boundary = 'old';
      break;
    }
    fresh.push(...parseTraffyResults(results, now));
    const times = results.map((r) => parseUtc(r.timestamp)?.getTime() ?? now.getTime());
    oldestSeenMs = Math.min(oldestSeenMs, ...times);
    if (times.every((t) => t < cutoffMs)) { boundary = 'old'; break; }
    // A page is 'known' when every ticket is already held or would not produce an event anyway.
    if (known.size && results.every((r) => known.has(`traffy:${r.ticket_id}`) || parseTraffyResults([r], now).length === 0)) { boundary = 'known'; break; }
  }
  let coveredMs: number;
  if (boundary === 'old') coveredMs = cutoffMs;
  else if (boundary === 'known' && prevCoveredSince) coveredMs = Math.max(cutoffMs, Date.parse(prevCoveredSince));
  else coveredMs = Math.max(cutoffMs, oldestSeenMs);
  const stillValid = prev.filter((e) => Date.parse(e.t) >= cutoffMs);
  const byId = new Map<string, FloodEvent>();
  for (const e of [...stillValid, ...fresh]) byId.set(e.id, e);
  return { events: dedupTraffy([...byId.values()]), coveredSince: toIso07(new Date(coveredMs)) };
}
