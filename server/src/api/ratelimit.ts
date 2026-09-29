import { RATE } from '../../../src/core/alert-config';
import type { Db } from '../db/db';
import type { Env } from './env';
import { HttpError } from './http';

export type Window = 'minute' | 'hour' | 'day';

/** First 8 bytes of HMAC-SHA256(data) as 16 hex characters. */
export async function hmac16(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return [...sig.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Buckets: minute "YYYY-MM-DDTHH:MM", hour "YYYY-MM-DDTHH", day "YYYY-MM-DD" (UTC; the daily
 *  cleanup compares these strings). */
export const windowKey = (now: Date, window: Window): string => now.toISOString().slice(0, window === 'day' ? 10 : window === 'hour' ? 13 : 16);

/** A domain-separated counter name; the raw material (IP, endpoint, chat id) is never stored. */
export async function rateName(secret: string, prefix: string, material: string): Promise<string> {
  return `${prefix}:${await hmac16(secret, `${prefix}|${material}`)}`;
}

/** Check-and-increment one bucket, and STOP writing once it is at `limit`: the conflicting row is
 *  left untouched and RETURNING is empty — the only "blocked" signal (never `?? 0`). */
export async function rateOnce(q: Db, name: string, bucket: string, limit: number): Promise<boolean> {
  const r = await q.query('INSERT INTO counter (name, day, n) VALUES ($1, $2, 1) ON CONFLICT (name, day) DO UPDATE SET n = counter.n + 1 WHERE counter.n < $3 RETURNING n', [name, bucket, limit]);
  return r.rows.length > 0;
}

export async function counterRate(env: Env, prefix: string, material: string, limit: number, now: Date, window: Window = 'minute'): Promise<boolean> {
  if (!env.RATE_HMAC_KEY) throw new HttpError(503, 'unavailable');
  return rateOnce(env.db, await rateName(env.RATE_HMAC_KEY, prefix, material), windowKey(now, window), limit);
}

/** A minute burst cap AND a day cap in one transaction, in the original order: the minute insert's
 *  source row exists only while the day bucket is under `dayLimit`, so once the day cap is reached
 *  nothing is written at all. Under READ COMMITTED, requests arriving at the very same moment can
 *  overshoot a cap by at most the pool size (5) — accepted: the caps stop abuse, not exact counts. */
async function minuteAndDay(env: Env, name: string, minuteLimit: number, dayLimit: number, now: Date): Promise<boolean> {
  const minuteBucket = windowKey(now, 'minute');
  const dayBucket = windowKey(now, 'day');
  return env.db.tx(async (t) => {
    const m = await t.query('INSERT INTO counter (name, day, n) SELECT $1::text, $2::text, 1 WHERE COALESCE((SELECT n FROM counter WHERE name = $1::text AND day = $3::text), 0) < $4::integer ON CONFLICT (name, day) DO UPDATE SET n = counter.n + 1 WHERE counter.n < $5 RETURNING n', [name, minuteBucket, dayBucket, dayLimit, minuteLimit]);
    const d = await t.query('INSERT INTO counter (name, day, n) VALUES ($1, $2, 1) ON CONFLICT (name, day) DO UPDATE SET n = counter.n + 1 WHERE counter.n < $3 RETURNING n', [name, dayBucket, dayLimit]);
    return m.rows.length > 0 && d.rows.length > 0;
  });
}

export async function counterRateDaily(env: Env, prefix: string, material: string, minuteLimit: number, dayLimit: number, now: Date): Promise<boolean> {
  if (!env.RATE_HMAC_KEY) throw new HttpError(503, 'unavailable');
  return minuteAndDay(env, await rateName(env.RATE_HMAC_KEY, prefix, material), minuteLimit, dayLimit, now);
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

/** Per-IP limits for the public push routes, POST and DELETE alike (write budget). `ip` is the
 *  address client-ip.ts decided for this request (F1-6). */
export async function checkIpRate(env: Env, ip: string, now: Date): Promise<void> {
  if (!env.RATE_HMAC_KEY) throw new HttpError(503, 'unavailable');
  const name = await rateName(env.RATE_HMAC_KEY, 'rl', ipRateKey(ip));
  if (!(await minuteAndDay(env, name, RATE.subscribePerIpPerMin, RATE.subscribePerIpPerDay, now))) throw new HttpError(429, 'rate_limited', { 'retry-after': '60' });
}
