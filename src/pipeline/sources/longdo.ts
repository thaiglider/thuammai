import { createHash } from 'node:crypto';
import { isImpassable, isPassable, parseDepthCm, sanitizeText } from '../../core/depth-text';
import { inThailand } from '../../core/geo';
import { EVENT_AGE_H } from '../../core/thresholds';
import { isTooFarInFuture, parseLocal, toIso07 } from '../../core/time';
import type { FloodEvent, Reporter } from '../../core/types';

export const LONGDO_URL = 'https://event.longdo.com/feed/json';

/** Stable pseudonym for a contributor: only used to count distinct senders, never shown. */
export const senderHash = (contributor: string): string =>
  createHash('sha256').update(`thuammai:${contributor}`).digest('hex').slice(0, 10);

function reporterOf(contributor: string | undefined): Reporter {
  if (contributor === 'DOH Admin') return 'highway';
  if (contributor && /^itic/i.test(contributor)) return 'itic';
  return 'public';
}

export function parseLongdo(raw: any, now: Date): FloodEvent[] {
  const out: FloodEvent[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!(e.type === '6' || e.icon === 'flood')) continue;
    const title = String(e.title ?? '');
    const text = `${title} ${e.description ?? ''}`;
    if (/ดินสไลด์|ดินถล่ม/.test(text)) continue;
    const lat = Number(e.latitude);
    const lon = Number(e.longitude);
    const start = parseLocal(e.start);
    if (!start || isTooFarInFuture(start, now) || !inThailand(lat, lon)) continue;
    const reporter = reporterOf(e.contributor);
    if ((now.getTime() - start.getTime()) / 3600e3 > EVENT_AGE_H[reporter]) continue;
    out.push({
      id: `longdo:${e.eid}`, source: 'longdo', reporter,
      by: reporter === 'public' && e.contributor ? senderHash(String(e.contributor)) : undefined,
      lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, t: toIso07(start),
      title: sanitizeText(title),
      passable: isImpassable(text) ? false : isPassable(text) ? true : null,
      depthCm: parseDepthCm(text),
    });
  }
  return out;
}
