import { ALERT, TREND_ALERT } from './alert-config';
import type { Shown } from './hysteresis';
import { TREND } from './thresholds';
import type { Trend, WaterKind } from './trend';
import type { Level } from './types';

export type TrendRun = 'falling' | 'rising' | 'fast';
export interface TrendPoint { tr?: TrendRun; trSince?: string }

/** The usable kind of a point trend (spec §2.1); tidal, unknown, mixed and stable count as no trend. */
export function trendRun(t: Trend | null): TrendRun | null {
  if (!t || t.tidal) return null;
  if (t.state === 'falling') return 'falling';
  if (t.state !== 'rising') return null;
  return t.direct === true && t.cmPerH !== undefined && t.cmPerH >= TREND.fastCmH ? 'fast' : 'rising';
}

/** falling, or up (rising and fast are one family for the hold: a station hovering around
 *  TREND.fastCmH must not restart the count). */
const family = (r: TrendRun): 'down' | 'up' => (r === 'falling' ? 'down' : 'up');

/** One snapshot's trend → next run state; `tr` is always the CURRENT kind, `trSince` the start of
 *  the family run. null (bad snapshot, gap, no usable trend) or a change of family restarts it. */
export function stepTrend(prev: TrendPoint | undefined, trend: Trend | null, gen: string): TrendPoint {
  const run = trendRun(trend);
  if (run === null) return {};
  if (prev?.tr !== undefined && prev.trSince !== undefined && family(prev.tr) === family(run)) return { tr: run, trSince: prev.trSince };
  return { tr: run, trSince: gen };
}

const minutesBetween = (from: string | null, to: string): number =>
  (from === null ? Infinity : (Date.parse(to) - Date.parse(from)) / 60e3);

/** The current kind once its family run has lasted long enough, else null ('fast' only when the
 *  current kind is fast). */
export const trendHeld = (p: TrendPoint, gen: string): TrendRun | null =>
  p.tr !== undefined && p.trSince !== undefined && minutesBetween(p.trSince, gen) >= TREND_ALERT.holdMin ? p.tr : null;

export type TrendKind = 'trend_fall' | 'trend_rise' | 'trend_fast';
export interface TrendFollow { trendNote: 'fall' | 'rise' | 'fast' | null; trendAt: string | null }

/** Per follower after decideFollow found nothing to send (spec §2.2). `station`: the kind of the
 *  station behind the trend (Trend.kind). */
export function decideTrend(
  f: { alerted: 0 | 3 | 4; lastAlertAt: string | null } & TrendFollow,
  p: { shown: Shown | null; valid: boolean; raw: Level; held: TrendRun | null; station?: WaterKind | undefined },
  gen: string,
): { kind: TrendKind | null; next: TrendFollow } {
  const none = { kind: null, next: { trendNote: f.trendNote, trendAt: f.trendAt } };
  if (!p.valid || p.held === null) return none;
  const gap = minutesBetween(f.trendAt, gen);
  const high = p.shown === 3 || p.shown === 4;

  if (p.held === 'falling') {
    if (f.alerted !== 0 && high && f.trendNote !== 'fall' && gap >= TREND_ALERT.minGapMin && minutesBetween(f.lastAlertAt, gen) >= TREND_ALERT.afterAlertMin) {
      return { kind: 'trend_fall', next: { trendNote: 'fall', trendAt: gen } };
    }
    return none;
  }
  if (high) {
    // Only the 30-minute hold: the fall message promised to tell when the water rises again.
    if (f.trendNote === 'fall') {
      return { kind: 'trend_rise', next: { trendNote: 'rise', trendAt: gen } };
    }
    return none;
  }
  // At level 1 only a road or canal station counts (a river rising fast far below its bank is common).
  const station = p.raw === 2 || (p.raw === 1 && (p.station === 'road' || p.station === 'canal'));
  if (p.held === 'fast' && f.alerted === 0 && p.shown === 'lt3' && station && gap >= ALERT.repeatH * 60) {
    return { kind: 'trend_fast', next: { trendNote: 'fast', trendAt: gen } };
  }
  return none;
}

/** Applied when decideFollow sent alert3/alert4/clear: a new episode starts counting afresh (trendAt kept). */
export const resetTrendOnAlert = (f: TrendFollow): TrendFollow => ({ trendNote: null, trendAt: f.trendAt });
