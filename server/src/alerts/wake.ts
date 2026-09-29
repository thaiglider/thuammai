import pg from 'pg';
import type { Counts } from '../../../src/alerts/log';
import type { PgConn } from '../db/pg';

/* LISTEN thuammai_wake on a connection of its own (phase-3C spec §5.2): the api NOTIFYs when a LINE
 * location is queued, so alerts answers within seconds instead of at the next 60-s tick. Lost
 * connection → reconnect with backoff; meanwhile questions are still answered at the normal tick
 * (and the api's 40-s fallback covers the token). */

export const WAKE_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

export interface WakeClient {
  connect(): Promise<void>;
  /** LISTEN thuammai_wake — a method, not query(sql): SQL stays a literal at its one call site. */
  listen(): Promise<void>;
  on(event: 'notification' | 'error' | 'end', fn: () => void): unknown;
  end(): Promise<void>;
}
export interface WakeDeps { client(): WakeClient; onWake(): void; sleep(ms: number): Promise<void>; log(counts: Counts): void }

export function wakeListener(d: WakeDeps): { stop(): Promise<void> } {
  let stopped = false;
  let current: WakeClient | null = null;
  const run = async (): Promise<void> => {
    let fails = 0;
    let first = true;
    while (!stopped) {
      // d.client() itself can throw (bad config) — counted separately from a connect/LISTEN
      // failure, and never left to reject run() (fix round 1 #2).
      let c: WakeClient;
      try {
        c = d.client();
      } catch {
        d.log({ wake_failed: 1 });
        if (stopped) return;
        await d.sleep(WAKE_BACKOFF_MS[Math.min(fails++, WAKE_BACKOFF_MS.length - 1)]!);
        continue;
      }
      const lost = new Promise<void>((res) => { c.on('error', () => res()); c.on('end', () => res()); });
      try {
        await c.connect();
        // Guarded on `stopped`, not just removed after stop(): the listener may still be attached
        // to a real socket for a moment, and a fake client's caller may emit manually (fix round 1 #1).
        c.on('notification', () => { if (!stopped) d.onWake(); });
        await c.listen();
        current = c;
        fails = 0;
        // stop() ran while connect()/listen() was still pending: end now, skip the catch-up wake,
        // and never await `lost` (nothing would ever end it) — fix round 1 #1.
        if (stopped) { current = null; await c.end().catch(() => undefined); return; }
        // Notifications sent while we were away are lost: look once (G-14).
        if (!first) d.onWake();
        first = false;
        await lost;
      } catch {
        // connect or LISTEN failed: back off below
      }
      current = null;
      await c.end().catch(() => undefined);
      if (stopped) return;
      d.log({ wake_reconnect: 1 });
      await d.sleep(WAKE_BACKOFF_MS[Math.min(fails++, WAKE_BACKOFF_MS.length - 1)]!);
    }
  };
  // A safety net: whatever else might throw (e.g. d.log itself), run() must never reject
  // unobserved — an unhandled rejection here would take the whole alerts process down over what
  // is only an optional latency optimisation (fix round 1 #2).
  const done = run().catch(() => { try { d.log({ wake_failed: 1 }); } catch { /* never let logging itself throw further */ } });
  return {
    async stop() {
      stopped = true;
      await current?.end().catch(() => undefined);
      await done;
    },
  };
}

/** A pg.Client per connection attempt (never from the pool: LISTEN needs one session). */
export const pgWakeClient = (conn: PgConn) => (): WakeClient => {
  const c = new pg.Client({ ...conn, application_name: 'thuammai-alerts-wake', keepAlive: true, connectionTimeoutMillis: 5_000 });
  const events = c as unknown as NodeJS.EventEmitter;
  return {
    connect: async () => { await c.connect(); },
    listen: async () => { await c.query('LISTEN thuammai_wake'); },
    on: (event, fn) => events.on(event, fn),
    end: () => c.end(),
  };
};
