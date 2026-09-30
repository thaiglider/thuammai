import { allowedOrigin, type Deps, type Env } from './env';
import { empty, err, json } from './http';

export type AlertsStatus = 'on' | 'paused' | 'stalled';
/** alert_run.tick_at older than this → the sender is stalled (spec §4.2). */
export const STALL_MS = 5 * 60_000;
const MEMO_MS = 30_000;
let memo: { at: number; tickAt: number } | null = null;
export function resetStatusMemo(): void { memo = null; }

/** paused (switch on, no database read) · stalled · on. Throws when the database fails. */
export async function alertsStatus(env: Env, now: Date): Promise<AlertsStatus> {
  if (env.ALERTS_PAUSED) return 'paused';
  if (!memo || now.getTime() - memo.at >= MEMO_MS || now.getTime() < memo.at) {
    const r = await env.db.query<{ tick_at: Date }>('SELECT tick_at FROM alert_run WHERE id = 1');
    memo = { at: now.getTime(), tickAt: r.rows[0]?.tick_at.getTime() ?? 0 };
  }
  return now.getTime() - memo.tickAt > STALL_MS ? 'stalled' : 'on';
}

/** GET /v1/status (spec §4.2, F1-7): any caller gets 200 (Uptime Kuma, vps-watch); CORS only for the site. */
export async function statusRoute(req: Request, env: Env, deps: Deps): Promise<Response> {
  const origin = allowedOrigin(req, env);
  const cors: Record<string, string> = origin !== null ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };
  if (req.method === 'OPTIONS') return empty(204, { ...cors, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' });
  if (req.method !== 'GET') return err(405, 'method_not_allowed', cors);
  try {
    return json(200, { ok: true, alerts: await alertsStatus(env, deps.now()) }, { ...cors, 'cache-control': 'public, max-age=30' });
  } catch {
    return err(503, 'unavailable', cors);
  }
}
