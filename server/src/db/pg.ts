import pg from 'pg';
import type { Db, QueryResult } from './db';
import { parseInt8 } from './int8';

// Process-wide: this process only ever talks to our own database.
pg.types.setTypeParser(pg.types.builtins.INT8, parseInt8);

export type PgConn = { host: string; port: number; database: string; user: string; password: string } | { connectionString: string };

const result = <T>(r: pg.QueryResult): QueryResult<T> => ({ rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length });

function clientDb(c: pg.PoolClient | pg.Client, inTx: boolean): Db {
  const self: Db = {
    query: async <T>(sql: string, params: unknown[] = []) => result<T>(await c.query(sql, params)),
    exec: async (sql) => { await c.query(sql); },
    tx: async (fn) => {
      if (inTx) return fn(self);
      await c.query('BEGIN');
      try {
        const out = await fn(clientDb(c, true));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    },
    session: async (fn) => fn(self),
  };
  return self;
}

/** A pool. Idle-client errors are swallowed on purpose: the next query reconnects, and an error
 *  object may carry SQL parameters (never logged — spec §7.4). */
export function createPool(conn: PgConn, o: { max: number; applicationName: string }): pg.Pool {
  const pool = new pg.Pool({ ...conn, max: o.max, application_name: o.applicationName, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, keepAlive: true });
  pool.on('error', () => undefined);
  return pool;
}

export function poolDb(pool: pg.Pool): Db {
  const withClient = async <R>(fn: (c: pg.PoolClient) => Promise<R>): Promise<R> => {
    const c = await pool.connect();
    let broken = false;
    try {
      return await fn(c);
    } catch (e) {
      // A server-side SQL error (it has a SQLSTATE `code`) leaves the connection usable; anything else may not.
      broken = !(e instanceof Error && typeof (e as { code?: unknown }).code === 'string');
      throw e;
    } finally {
      c.release(broken);
    }
  };
  return {
    query: async <T>(sql: string, params: unknown[] = []) => result<T>(await pool.query(sql, params)),
    exec: (sql) => withClient(async (c) => { await c.query(sql); }),
    tx: (fn) => withClient((c) => clientDb(c, false).tx(fn)),
    session: (fn) => withClient((c) => fn(clientDb(c, false))),
  };
}
