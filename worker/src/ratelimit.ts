import { RATE } from '../../src/core/alert-config';
import type { D1PreparedStatement, Env } from './env';
import { HttpError } from './http';

export type Window = 'minute' | 'hour' | 'day';

/** First 8 bytes of HMAC-SHA256(data) as 16 hex characters. */
export async function hmac16(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return [...sig.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The counter bucket for a window: per-minute "YYYY-MM-DDTHH:MM", per-hour "YYYY-MM-DDTHH", or
 *  per-day "YYYY-MM-DD" (UTC date, same format `utcDay` uses). All three share the "YYYY-MM-DD"
 *  prefix the daily cron's string comparison relies on. */
export const windowKey = (now: Date, window: Window): string => now.toISOString().slice(0, window === 'day' ? 10 : window === 'hour' ? 13 : 16);

/** A domain-separated counter name: never the same hash for the same material under a different
 *  prefix (rl/sub/np), and the raw material (IP, endpoint, …) is never itself stored. Exported so
 *  push.ts's daily per-target "np" cap (not a counterRate window check) uses the same
 *  hashing formula instead of a second copy of it. */
export async function rateName(secret: string, prefix: string, material: string): Promise<string> {
  return `${prefix}:${await hmac16(secret, `${prefix}|${material}`)}`;
}

/** The one INSERT this file ever runs to check-and-increment a counter — and, critically, to STOP
 *  incrementing (and writing at all) once a bucket is already at `limit`: a flood of already-over-
 *  limit requests must not keep costing D1 writes (spec ruling: write budget, not just row-count).
 *  `WHERE n < ?` on the DO UPDATE means a conflicting row already at/over `limit` is left untouched
 *  — no write happens, and RETURNING then yields no row at all, which is the only signal callers
 *  trust for "blocked" (see counterRate below). One code path for the single-check and batched
 *  multi-check that follow, and for push.ts's own per-target "sub" throttle when it needs this
 *  check folded into a bigger batch — the sql-guard test requires the literal to be inlined at
 *  each prepared-statement call site, so it can't be hoisted into a shared string constant. */
export function rateStmt(env: Env, name: string, bucket: string, limit: number): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO counter (name, day, n) VALUES (?, ?, 1) ON CONFLICT (name, day) DO UPDATE SET n = n + 1 WHERE n < ? RETURNING n').bind(name, bucket, limit);
}

/** A per-window counter in D1 keyed by a domain-separated HMAC of `material`; the daily cron
 *  deletes rows older than about a day. True when this request is within `limit` for its window —
 *  an EMPTY RETURNING (no row at all, not merely `n` missing) is the only "blocked" signal; there
 *  is deliberately no `?? 0` fallback here, since defaulting a missing row to 0 would silently
 *  re-allow every further request against an already-maxed-out bucket (the bug this file fixes). */
export async function counterRate(env: Env, prefix: string, material: string, limit: number, now: Date, window: Window = 'minute'): Promise<boolean> {
  if (!env.INTERNAL_TOKEN) throw new HttpError(503, 'unavailable');
  const name = await rateName(env.INTERNAL_TOKEN, prefix, material);
  const r = await rateStmt(env, name, windowKey(now, window), limit).first<{ n: number }>();
  return r !== null;
}

/** IPv4 unchanged; an IPv4-mapped (`::ffff:1.2.3.4`) or IPv4-compatible (`::1.2.3.4`) IPv6 address
 *  keys on the embedded IPv4 address itself (a "/64" of it makes no sense — it's one translated
 *  IPv4 host, not an IPv6 network); any other IPv6 address is collapsed to its /64 (the size an
 *  ISP typically hands one customer, so one address family isn't trivially worked around by
 *  cycling addresses within the same /64). */
export function ipRateKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const embeddedV4 = ip.slice(ip.lastIndexOf(':') + 1);
  if (embeddedV4.includes('.')) return embeddedV4;
  let groups: string[];
  if (ip.includes('::')) {
    const [head, tail = ''] = ip.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const zeros = Math.max(0, 8 - headParts.length - tailParts.length);
    groups = [...headParts, ...Array<string>(zeros).fill('0'), ...tailParts];
  } else {
    groups = ip.split(':');
  }
  // Canonicalize each group (no leading zeros) so "0db8" and "db8" collapse to the same /64.
  const canon = groups.slice(0, 4).map((g) => (g === '' ? '0' : parseInt(g, 16).toString(16)));
  return `${canon.join(':')}::/64`;
}

/** Per-IP limits for the public push routes (spec §4) — a per-minute burst cap and a per-day cap,
 *  applied to POST and DELETE alike (write budget, not data growth, is the concern; DELETE gets no
 *  exemption), in one D1 round trip. Once an IP is already at/over its DAY cap, the minute-bucket
 *  statement writes nothing at all either — its `INSERT … SELECT … WHERE <day count> < dayLimit`
 *  source clause means there is no row to insert or conflict-update, so a request from an
 *  already-capped-for-the-day IP costs zero further D1 writes, no matter how many more it sends.
 *  The day statement runs second, in the same batch, so its subquery sees the day count from
 *  *before* this request (this request's own day-increment hasn't happened yet) — the request that
 *  fills the last slot of the day still gets to write both rows; only the first request past that
 *  point (and everything after it, that day) writes nothing. The raw IP is never stored. */
export async function checkIpRate(req: Request, env: Env, now: Date): Promise<void> {
  if (!env.INTERNAL_TOKEN) throw new HttpError(503, 'unavailable');
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const name = await rateName(env.INTERNAL_TOKEN, 'rl', ipRateKey(ip));
  const minuteBucket = windowKey(now, 'minute');
  const dayBucket = windowKey(now, 'day');
  const results = await env.DB.batch([
    env.DB.prepare('INSERT INTO counter (name, day, n) SELECT ?, ?, 1 WHERE COALESCE((SELECT n FROM counter WHERE name = ? AND day = ?), 0) < ? ON CONFLICT (name, day) DO UPDATE SET n = n + 1 WHERE n < ? RETURNING n').bind(name, minuteBucket, name, dayBucket, RATE.subscribePerIpPerDay, RATE.subscribePerIpPerMin),
    env.DB.prepare('INSERT INTO counter (name, day, n) VALUES (?, ?, 1) ON CONFLICT (name, day) DO UPDATE SET n = n + 1 WHERE n < ? RETURNING n').bind(name, dayBucket, RATE.subscribePerIpPerDay),
  ]);
  if (results[0]!.results.length === 0 || results[1]!.results.length === 0) throw new HttpError(429, 'rate_limited', { 'retry-after': '60' });
}
