import { CAPS } from '../../src/core/alert-config';
import type { D1Database, D1PreparedStatement } from './env';

interface Totals { tt: number; tn: number; td: number; pt: number; pn: number }

/** Capacity without COUNT(*) on every sign-up (spec ruling 1): totals recomputed by the daily
 *  cron + everything added since, and today's new targets. Deletions are only seen at the next
 *  cron, so the check can say "full" a little early but never lets the tables grow past the caps. */
export async function capsAllow(db: D1Database, day: string, newTargets: number, newPlaces: number): Promise<boolean> {
  if (newTargets <= 0 && newPlaces <= 0) return true;
  const t = await db.prepare("SELECT COALESCE((SELECT n FROM counter WHERE name = 'targets_total' AND day = 'all'), 0) AS tt, COALESCE((SELECT n FROM counter WHERE name = 'targets_new' AND day = 'all'), 0) AS tn, COALESCE((SELECT n FROM counter WHERE name = 'new_targets' AND day = ?), 0) AS td, COALESCE((SELECT n FROM counter WHERE name = 'places_total' AND day = 'all'), 0) AS pt, COALESCE((SELECT n FROM counter WHERE name = 'places_new' AND day = 'all'), 0) AS pn").bind(day).first<Totals>();
  const c = t ?? { tt: 0, tn: 0, td: 0, pt: 0, pn: 0 };
  if (newTargets > 0 && (c.tt + c.tn + newTargets > CAPS.maxTargets || c.td + newTargets > CAPS.newTargetsPerDay)) return false;
  if (newPlaces > 0 && c.pt + c.pn + newPlaces > CAPS.maxPlaces) return false;
  return true;
}

/** Counter increments to put in the same batch as the inserts they count. */
export function countStatements(db: D1Database, day: string, newTargets: number, newPlaces: number): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  if (newTargets > 0) {
    out.push(db.prepare('INSERT INTO counter (name, day, n) VALUES (?, ?, ?) ON CONFLICT (name, day) DO UPDATE SET n = n + excluded.n').bind('new_targets', day, newTargets));
    out.push(db.prepare('INSERT INTO counter (name, day, n) VALUES (?, ?, ?) ON CONFLICT (name, day) DO UPDATE SET n = n + excluded.n').bind('targets_new', 'all', newTargets));
  }
  if (newPlaces > 0) {
    out.push(db.prepare('INSERT INTO counter (name, day, n) VALUES (?, ?, ?) ON CONFLICT (name, day) DO UPDATE SET n = n + excluded.n').bind('places_new', 'all', newPlaces));
  }
  return out;
}

/** Increments a named counter by `add`, clamped at `cap`. push.ts rejects over-cap requests earlier
 *  (a plain read against the same cap), so this only matters when two requests for one target race:
 *  the counter then still records the attempt (saturates at `cap`) instead of skipping the write,
 *  so later requests are refused (fails closed). */
export function boundedCountStmt(db: D1Database, name: string, day: string, add: number, cap: number): D1PreparedStatement {
  return db.prepare('INSERT INTO counter (name, day, n) VALUES (?, ?, ?) ON CONFLICT (name, day) DO UPDATE SET n = MIN(n + excluded.n, ?) RETURNING n').bind(name, day, add, cap);
}
