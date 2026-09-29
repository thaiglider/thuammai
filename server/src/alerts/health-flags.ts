import type { Counts } from '../../../src/alerts/log';
import { ALERT, CAPS } from '../../../src/core/alert-config';
import type { CapsUsage } from './run-state';

export interface HealthInput {
  paused: boolean; now: Date;
  /** meta.generatedAt last seen on Pages (null: never fetched). */
  pagesGen: string | null;
  /** alert_run.gen (null: nothing processed yet). */
  runGen: string | null;
  lastCounts: Counts | null; deferredStreak: number; usage: CapsUsage | null;
  /** Since when meta/snapshot fetching has failed without a success (ms), or null. */
  fetchFailingSince: number | null;
  dbOk: boolean;
}
export const GEN_LAG_MIN = 20;
export const FETCH_ERROR_MIN = 10;

/** The short codes pushed to Uptime Kuma (spec §10.2, F1-11) — never user data. */
export function healthFlags(h: HealthInput): string[] {
  if (h.paused) return ['paused'];
  const out: string[] = [];
  const now = h.now.getTime();
  if (!h.dbOk) out.push('db_unavailable');
  if (h.pagesGen === null || (now - Date.parse(h.pagesGen)) / 60e3 > ALERT.maxSnapshotAgeMin) out.push('data_stale');
  else if (h.dbOk && (h.runGen === null || (Date.parse(h.pagesGen) - Date.parse(h.runGen)) / 60e3 > GEN_LAG_MIN)) out.push('gen_lag');
  if (h.lastCounts?.push_stopped) out.push('push_stopped');
  if (h.lastCounts?.tg_auth) out.push('tg_auth');
  if (h.deferredStreak >= 3) out.push('deferred');
  const u = h.usage;
  if (u && (u.targets >= 0.7 * CAPS.maxTargets || u.places >= 0.7 * CAPS.maxPlaces || u.newTargetsToday >= 0.7 * CAPS.newTargetsPerDay)) out.push('cap_70');
  if (h.fetchFailingSince !== null && now - h.fetchFailingSince > FETCH_ERROR_MIN * 60e3) out.push('fetch_error');
  return out;
}

/** Up only when nothing but "paused" (intentional) is flagged. */
export const kumaStatus = (flags: string[]): 'up' | 'down' => (flags.every((f) => f === 'paused') ? 'up' : 'down');
