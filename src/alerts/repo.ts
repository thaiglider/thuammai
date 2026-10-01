import type { PointState } from '../core/alert-rule';
import type { TrendFollow } from '../core/trend-alert';
import type { Counts } from './log';

/* Where the alerts logic reads and writes (spec §6.2, R7). No driver import here: src/alerts runs
 * the same on Postgres (server/src/alerts/repo-pg.ts) and in tests. */
export interface PlaceRow { k: string; lat: number; lon: number }
export interface FollowRow {
  fid: number; targetId: number; key: string; ch: 'push' | 'tg' | 'line'; label: string | null;
  endpoint: string | null; p256dh: string | null; auth: string | null; chat: number | null;
  /** LINE user id of a 'line' target (phase 3C). */
  lineUser: string | null;
  alerted: 0 | 3 | 4; lastAlertAt: string | null; lastL4At: string | null; lastClearAt: string | null;
  /** Trend alerts (H4): null on rows written before 0005 or by an older image. */
  trendNote: TrendFollow['trendNote']; trendAt: string | null;
}
export interface FollowUpdate { fid: number; alerted: 0 | 3 | 4; lastAlertAt: string | null; lastL4At: string | null; lastClearAt: string | null; trendNote: TrendFollow['trendNote']; trendAt: string | null }
export interface Report { follows: FollowUpdate[]; deadTargets: number[]; donePending: number[] }
/** `fid`/`label` (Plan O): set only for a "ดู" request whose follow still belongs to this chat and key. */
export interface PendingRow { id: number; chat: number; k: string; lat: number; lon: number; createdAt: string; fid: number | null; label: string | null }
/** Place-level alert state (phase-2 spec §3) — rows of point_state plus alert_run.gen. */
export interface AlertStateBlob { v: 1; gen: string; places: Record<string, PointState> }

/** Any failure of the store. The message is fixed and the cause is dropped on purpose: driver
 *  errors carry SQL and parameters (endpoints, chat ids, labels) that must never reach a log. */
export class RepoError extends Error {
  constructor() {
    super('repository call failed');
    this.name = 'RepoError';
  }
}

export interface AlertRepo {
  /** Every place, in key order. */
  places(): Promise<PlaceRow[]>;
  /** All point states + alert_run.gen; null before the first save. */
  loadState(): Promise<AlertStateBlob | null>;
  /** One transaction: upsert keys whose value changed from `prev`, delete keys gone from `next`,
   *  move alert_run.gen forward (or keep it) — 'older' when the stored gen is newer (nothing written). */
  saveState(prev: AlertStateBlob | null, next: AlertStateBlob): Promise<'ok' | 'older'>;
  /** Stored states of just these keys (the per-tick question answers, F1-2). */
  pointStates(keys: string[]): Promise<Record<string, PointState>>;
  /** Follow rows of these keys (≤1,000 keys per query). */
  targets(keys: string[]): Promise<FollowRow[]>;
  /** One transaction; ids that no longer exist are skipped silently. */
  report(r: Report): Promise<void>;
  /** Questions younger than CAPS.tgPendingTtlMin, oldest first, at most CAPS.tgPerRun. */
  tgPending(now: Date): Promise<PendingRow[]>;
  /** alert_run.run_at and last_counts (numbers only). */
  finishRun(at: Date, counts: Counts): Promise<void>;
}
