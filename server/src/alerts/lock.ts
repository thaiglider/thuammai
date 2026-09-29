import pg from 'pg';
import type { PgConn } from '../db/pg';

/** The single sender (spec §4.3, R7): a session-level advisory lock on its own connection. */
export const ALERTS_LOCK = 7700310001;
export interface AdvisoryLock {
  tryAcquire(): Promise<boolean>;
  /** A round trip on the lock's connection; false (and onLost) when it is gone. */
  ping(): Promise<boolean>;
  onLost(fn: () => void): void;
  release(): Promise<void>;
}

export function pgAdvisoryLock(conn: PgConn, key = ALERTS_LOCK): AdvisoryLock {
  let client: pg.Client | null = null;
  let held = false;
  const lost: (() => void)[] = [];
  const drop = (): void => {
    const was = held;
    held = false;
    const c = client;
    client = null;
    void c?.end().catch(() => undefined);
    if (was) for (const f of lost) f();
  };
  return {
    async tryAcquire() {
      try {
        if (!client) {
          const c = new pg.Client({ ...conn, application_name: 'thuammai-alerts-lock', keepAlive: true, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
          c.on('error', () => { if (client === c) drop(); });
          c.on('end', () => { if (client === c) drop(); });
          await c.connect();
          client = c;
        }
        const r = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key]);
        held = r.rows[0]?.ok === true;
        return held;
      } catch {
        drop();
        return false;
      }
    },
    async ping() {
      if (!client || !held) return false;
      try {
        await client.query('SELECT 1');
        return true;
      } catch {
        drop();
        return false;
      }
    },
    onLost(fn) { lost.push(fn); },
    async release() {
      held = false;
      const c = client;
      client = null;
      await c?.end().catch(() => undefined);
    },
  };
}
