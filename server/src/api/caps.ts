import { CAPS } from '../../../src/core/alert-config';
import type { Db } from '../db/db';

interface Totals { tt: number; tn: number; td: number; pt: number; pn: number }

/** Capacity without COUNT(*) per sign-up (phase-2 ruling 1): totals recomputed by the daily
 *  cleanup + everything added since, and today's new targets. Checked outside the write transaction,
 *  so concurrent sign-ups can overshoot a cap by at most the API's pool size (5) — accepted. */
export async function capsAllow(q: Db, day: string, newTargets: number, newPlaces: number): Promise<boolean> {
  if (newTargets <= 0 && newPlaces <= 0) return true;
  const r = await q.query<Totals>("SELECT COALESCE((SELECT n FROM counter WHERE name = 'targets_total' AND day = 'all'), 0) AS tt, COALESCE((SELECT n FROM counter WHERE name = 'targets_new' AND day = 'all'), 0) AS tn, COALESCE((SELECT n FROM counter WHERE name = 'new_targets' AND day = $1), 0) AS td, COALESCE((SELECT n FROM counter WHERE name = 'places_total' AND day = 'all'), 0) AS pt, COALESCE((SELECT n FROM counter WHERE name = 'places_new' AND day = 'all'), 0) AS pn", [day]);
  const c = r.rows[0] ?? { tt: 0, tn: 0, td: 0, pt: 0, pn: 0 };
  if (newTargets > 0 && (c.tt + c.tn + newTargets > CAPS.maxTargets || c.td + newTargets > CAPS.newTargetsPerDay)) return false;
  if (newPlaces > 0 && c.pt + c.pn + newPlaces > CAPS.maxPlaces) return false;
  return true;
}

/** Counter increments, inside the same transaction as the inserts they count. */
export async function addCounts(q: Db, day: string, newTargets: number, newPlaces: number): Promise<void> {
  if (newTargets > 0) {
    await q.query('INSERT INTO counter (name, day, n) VALUES ($1, $2, $3) ON CONFLICT (name, day) DO UPDATE SET n = counter.n + excluded.n', ['new_targets', day, newTargets]);
    await q.query('INSERT INTO counter (name, day, n) VALUES ($1, $2, $3) ON CONFLICT (name, day) DO UPDATE SET n = counter.n + excluded.n', ['targets_new', 'all', newTargets]);
  }
  if (newPlaces > 0) await q.query('INSERT INTO counter (name, day, n) VALUES ($1, $2, $3) ON CONFLICT (name, day) DO UPDATE SET n = counter.n + excluded.n', ['places_new', 'all', newPlaces]);
}

/** Increments a named counter by `add`, clamped at `cap` (fails closed when two requests race). */
export async function boundedCount(q: Db, name: string, day: string, add: number, cap: number): Promise<void> {
  await q.query('INSERT INTO counter (name, day, n) VALUES ($1, $2, $3) ON CONFLICT (name, day) DO UPDATE SET n = LEAST(counter.n + excluded.n, $4::integer)', [name, day, add, cap]);
}
