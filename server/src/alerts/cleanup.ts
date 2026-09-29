import { CAPS } from '../../../src/core/alert-config';
import type { Db } from '../db/db';

export interface CleanupCounts { targets: number; places: number; pending: number; counters: number; states: number; errors: number }
/** Rows per DELETE (the SQL literals below say LIMIT 5000 — keep them equal). */
export const CLEANUP_CHUNK = 5000;

/** Daily at 03:00 Bangkok inside the alerts process, under its lock (spec §5.3, replaces the
 *  Worker cron). Push targets go first so their follows cascade before the place sweep. A step
 *  that fails (e.g. a place deleted while a subscribe references it) is counted and skipped. */
export async function runCleanup(db: Db, now: Date): Promise<CleanupCounts> {
  const out: CleanupCounts = { targets: 0, places: 0, pending: 0, counters: 0, states: 0, errors: 0 };
  const loop = async (del: () => Promise<number>): Promise<number> => {
    let total = 0;
    for (;;) {
      const n = await del();
      total += n;
      if (n < CLEANUP_CHUNK) return total;
    }
  };
  const step = async (k: Exclude<keyof CleanupCounts, 'errors'>, del: () => Promise<number>) => {
    try { out[k] = await loop(del); } catch { out.errors++; }
  };
  const staleSync = new Date(now.getTime() - 180 * 86400e3);
  const pendingCut = new Date(now.getTime() - CAPS.tgPendingTtlMin * 60e3);
  // A full timestamp: minute/hour buckets are swept at close to 24 h; a bare-date row counts as the
  // start of that day (same string comparison as phase 2).
  const counterCut = new Date(now.getTime() - 86_400_000).toISOString();

  await step('targets', async () => (await db.query("DELETE FROM target WHERE id IN (SELECT t.id FROM target t WHERE (t.channel = 'push' AND (t.synced_at < $1 OR NOT EXISTS (SELECT 1 FROM follow f WHERE f.target_id = t.id))) OR (t.channel = 'tg' AND t.synced_at < $1 AND NOT EXISTS (SELECT 1 FROM follow f WHERE f.target_id = t.id)) LIMIT 5000)", [staleSync])).rowCount);
  await step('places', async () => (await db.query('DELETE FROM place WHERE key IN (SELECT p.key FROM place p WHERE NOT EXISTS (SELECT 1 FROM follow f WHERE f.key = p.key) LIMIT 5000)')).rowCount);
  await step('pending', async () => (await db.query('DELETE FROM tg_pending WHERE id IN (SELECT id FROM tg_pending WHERE created_at < $1 LIMIT 5000)', [pendingCut])).rowCount);
  await step('counters', async () => (await db.query("DELETE FROM counter WHERE (name, day) IN (SELECT name, day FROM counter WHERE day <> 'all' AND day < $1 LIMIT 5000)", [counterCut])).rowCount);
  await step('states', async () => (await db.query('DELETE FROM point_state WHERE key IN (SELECT s.key FROM point_state s WHERE NOT EXISTS (SELECT 1 FROM place p WHERE p.key = s.key) LIMIT 5000)')).rowCount);
  try {
    await db.tx(async (t) => {
      await t.query("INSERT INTO counter (name, day, n) SELECT 'targets_total', 'all', COUNT(*) FROM target ON CONFLICT (name, day) DO UPDATE SET n = excluded.n");
      await t.query("INSERT INTO counter (name, day, n) SELECT 'places_total', 'all', COUNT(*) FROM place ON CONFLICT (name, day) DO UPDATE SET n = excluded.n");
      await t.query("INSERT INTO counter (name, day, n) VALUES ('targets_new', 'all', 0), ('places_new', 'all', 0) ON CONFLICT (name, day) DO UPDATE SET n = 0");
    });
  } catch {
    out.errors++;
  }
  return out;
}
