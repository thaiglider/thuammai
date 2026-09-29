import { pathToFileURL } from 'node:url';
import { dbConn } from '../api/config';
import type { Db } from '../db/db';
import { createPool, poolDb } from '../db/pg';
import { fileSecrets } from '../secrets';

/** The deploy gate and the container healthcheck (spec §9.3 step 6), run inside `api`. One word out. */
export async function checkHealth(o: { base: string; fetchImpl: typeof fetch; db: Db | null; since: Date | null; allowPaused: boolean; live: boolean }): Promise<string> {
  try {
    const h = await o.fetchImpl(`${o.base}/v1/health`, { signal: AbortSignal.timeout(5_000) });
    if (h.status !== 200) return 'health_failed';
  } catch {
    return 'health_failed';
  }
  if (o.live) return 'ok';
  let alerts: unknown;
  try {
    alerts = ((await (await o.fetchImpl(`${o.base}/v1/status`, { signal: AbortSignal.timeout(5_000) })).json()) as { alerts?: unknown }).alerts;
  } catch {
    return 'status_failed';
  }
  if (alerts !== 'on' && !(alerts === 'paused' && o.allowPaused)) return typeof alerts === 'string' && /^[a-z]{1,10}$/.test(alerts) ? `status_${alerts}` : 'status_failed';
  if (o.since && o.db) {
    try {
      const r = (await o.db.query<{ tick_at: Date }>('SELECT tick_at FROM alert_run WHERE id = 1')).rows[0];
      if (!r || r.tick_at.getTime() <= o.since.getTime()) return 'tick_old';
    } catch {
      return 'db_error';
    }
  }
  return 'ok';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--since');
  const since = i >= 0 ? new Date(argv[i + 1] ?? '') : null;
  const conn = since ? dbConn(process.env, fileSecrets(process.env)) : null;
  const pool = conn ? createPool(conn, { max: 1, applicationName: 'thuammai-health' }) : null;
  checkHealth({ base: 'http://127.0.0.1:8080', fetchImpl: fetch, db: pool ? poolDb(pool) : null, since: since && !Number.isNaN(since.getTime()) ? since : null, allowPaused: argv.includes('--allow-paused'), live: argv.includes('--live') })
    .then(async (w) => { console.log(w); await pool?.end(); process.exit(w === 'ok' ? 0 : 1); });
}
