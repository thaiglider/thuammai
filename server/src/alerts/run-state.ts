import type { Db } from '../db/db';

/** The alerts heartbeat (spec §4.3): api reports "stalled" when this is older than 5 minutes. */
export async function heartbeat(db: Db, at: Date): Promise<void> {
  await db.query('UPDATE alert_run SET tick_at = $1 WHERE id = 1', [at]);
}

/** alert_run.gen as an ISO UTC string (for health flags); null before the first run. */
export async function storedGen(db: Db): Promise<string | null> {
  const r = (await db.query<{ gen: Date | null }>('SELECT gen FROM alert_run WHERE id = 1')).rows[0];
  return r?.gen ? r.gen.toISOString() : null;
}

export interface CapsUsage { targets: number; places: number; newTargetsToday: number }
/** The same counters capsAllow reads (for the cap_70 flag). */
export async function capsUsage(db: Db, day: string): Promise<CapsUsage> {
  // A template literal (no ${}): the SQL holds both quote characters.
  const r = (await db.query<CapsUsage>(`SELECT COALESCE((SELECT n FROM counter WHERE name = 'targets_total' AND day = 'all'), 0) + COALESCE((SELECT n FROM counter WHERE name = 'targets_new' AND day = 'all'), 0) AS targets, COALESCE((SELECT n FROM counter WHERE name = 'places_total' AND day = 'all'), 0) + COALESCE((SELECT n FROM counter WHERE name = 'places_new' AND day = 'all'), 0) AS places, COALESCE((SELECT n FROM counter WHERE name = 'new_targets' AND day = $1), 0) AS "newTargetsToday"`, [day])).rows[0];
  return r ?? { targets: 0, places: 0, newTargetsToday: 0 };
}
