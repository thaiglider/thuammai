/** The subset of Cloudflare's D1 API this Worker uses (kept local so the root tsconfig — DOM lib —
 *  type-checks the Worker without @cloudflare/workers-types). */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Env {
  DB: D1Database;
  SITE_ORIGIN: string;
  SITE_URL: string;
  INTERNAL_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

/** caches.default in Workers (tests pass an in-memory one). */
export interface CacheLike { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> }

/** Things handlers get injected (tests pass fakes). */
export interface Deps { now(): Date; fetch: typeof fetch; cache?: CacheLike | null }
