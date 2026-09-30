import { RepoError } from '../../../src/alerts/repo';
import type { SourceWatchRepo, WatchRow } from '../../../src/alerts/source-watch';
import type { Db } from '../db/db';
import { adminChat as readAdminChat } from '../line/store';

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new RepoError();
  }
}

/** source_watch (0007; recovered_at = cleared but kept for the rest of its notified Bangkok day)
 *  + the admin chat of the LINE notices. */
export function pgWatchRepo(db: Db): SourceWatchRepo {
  return {
    list: () => guard(async () => (await db.query<{ key: string; since: Date; day: string | null; recovered_at: Date | null }>("SELECT key, since, to_char(notified_day, 'YYYY-MM-DD') AS day, recovered_at FROM source_watch ORDER BY key")).rows
      .map((r): WatchRow => ({ key: r.key, since: new Date(r.since), notifiedDay: r.day, recoveredAt: r.recovered_at === null ? null : new Date(r.recovered_at) }))),
    upsert: (r) => guard(async () => {
      await db.query('INSERT INTO source_watch (key, since, notified_day, recovered_at) VALUES ($1, $2, $3::date, $4) ON CONFLICT (key) DO UPDATE SET since = excluded.since, notified_day = excluded.notified_day, recovered_at = excluded.recovered_at', [r.key, r.since, r.notifiedDay, r.recoveredAt]);
    }),
    remove: (key) => guard(async () => { await db.query('DELETE FROM source_watch WHERE key = $1', [key]); }),
    adminChat: () => guard(() => readAdminChat(db)),
  };
}
