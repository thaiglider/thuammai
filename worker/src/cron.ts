import { CAPS } from '../../src/core/alert-config';
import { toIso07 } from '../../src/core/time';
import type { D1Database, D1PreparedStatement } from './env';

/** Delete in chunks of ≤500 rows, at most 5 rounds, so each statement stays small. */
async function chunked(stmt: D1PreparedStatement): Promise<number> {
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const n = (await stmt.run()).meta.changes ?? 0;
    total += n;
    if (n < 500) break;
  }
  return total;
}

/** Daily at 03:00 Bangkok (spec §4 "Cron"). Push targets go first so their follows cascade and the
 *  place sweep that follows sees them gone. A Telegram chat is kept while it follows anything
 *  (until /stop or a 403); one with no follows and no activity (`synced_at`) for 180 days is
 *  deleted too, so it stops counting against `maxTargets` (final review M12). */
export async function runCron(db: D1Database, now: Date): Promise<{ targets: number; places: number; pending: number; counters: number }> {
  const staleSync = toIso07(new Date(now.getTime() - 180 * 86400e3));
  const pendingCut = toIso07(new Date(now.getTime() - CAPS.tgPendingTtlMin * 60e3));
  // A full timestamp, not just a date (spec §8 "HMAC ≤1 วัน"): the "day" column holds a plain
  // "YYYY-MM-DD" for the daily capacity counters and a minute/hour/day-prefixed string for
  // rl/sub/np — comparing against a full ISO instant (rather than a bare date) sweeps the
  // minute/hour rows at close to a true ~24h boundary, while a bare-date row is treated as the
  // very start of that day, so it's swept as soon as the cutoff reaches its calendar date.
  const counterCut = new Date(now.getTime() - 86_400_000).toISOString();
  const targets = await chunked(db.prepare("DELETE FROM target WHERE id IN (SELECT t.id FROM target t WHERE (t.channel = 'push' AND (t.synced_at < ? OR NOT EXISTS (SELECT 1 FROM follow f WHERE f.target_id = t.id))) OR (t.channel = 'tg' AND t.synced_at < ? AND NOT EXISTS (SELECT 1 FROM follow f WHERE f.target_id = t.id)) LIMIT 500)").bind(staleSync, staleSync));
  const places = await chunked(db.prepare('DELETE FROM place WHERE key IN (SELECT p.key FROM place p WHERE NOT EXISTS (SELECT 1 FROM follow f WHERE f.key = p.key) LIMIT 500)'));
  const pending = (await db.prepare('DELETE FROM tg_pending WHERE created_at < ?').bind(pendingCut).run()).meta.changes ?? 0;
  const counters = (await db.prepare("DELETE FROM counter WHERE day <> 'all' AND day < ?").bind(counterCut).run()).meta.changes ?? 0;
  await db.batch([
    db.prepare("INSERT INTO counter (name, day, n) SELECT 'targets_total', 'all', COUNT(*) FROM target WHERE true ON CONFLICT (name, day) DO UPDATE SET n = excluded.n"),
    db.prepare("INSERT INTO counter (name, day, n) SELECT 'places_total', 'all', COUNT(*) FROM place WHERE true ON CONFLICT (name, day) DO UPDATE SET n = excluded.n"),
    db.prepare("INSERT INTO counter (name, day, n) VALUES ('targets_new', 'all', 0), ('places_new', 'all', 0) ON CONFLICT (name, day) DO UPDATE SET n = 0"),
  ]);
  return { targets, places, pending, counters };
}
