/** The whole database surface the server uses (spec §6.3): `$n` parameters on both the `pg` pool
 *  (production) and PGlite (tests). SQL is always a string literal at the call site (guard test). */
export interface QueryResult<T> { rows: T[]; rowCount: number }
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** One transaction; a `tx` inside a `tx` runs flat on the same transaction. */
  tx<R>(fn: (t: Db) => Promise<R>): Promise<R>;
  /** A multi-statement script (migrations only). */
  exec(sql: string): Promise<void>;
  /** One pinned connection for the duration of `fn` (session-level advisory locks). */
  session<R>(fn: (s: Db) => Promise<R>): Promise<R>;
}
