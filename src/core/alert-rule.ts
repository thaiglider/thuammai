import { ALERT } from './alert-config';
import { alertShown, type PlaceHyst, type Shown } from './hysteresis';
import type { Level } from './types';

/** One place's entry in the alert-state blob (spec §3): hysteresis times, the start of the
 *  current "shown <3 with usable data" run, and whether some follower is inside an alert episode. */
export interface PointState extends PlaceHyst { below?: string; ep?: 1 }
export type PointInputState = { snapshotOk: false } | { snapshotOk: true; raw: Level; incomplete: boolean };
export interface PointStep { shown: Shown | null; valid: boolean; below?: string; next: PointState }

/** One snapshot for one place (spec §5.3 top). An unusable snapshot evaluates nothing: the
 *  hysteresis times are kept and the "below 3" clock restarts, so a clear is never sent from
 *  data we do not have. */
export function stepPoint(prev: PointState | undefined, input: PointInputState, gen: string): PointStep {
  if (!input.snapshotOk) {
    const next: PointState = { ...prev };
    delete next.below;
    return { shown: null, valid: false, next };
  }
  const h = alertShown(prev, input.raw, gen);
  const valid = !input.incomplete && h.shown !== 0;
  const below = valid && h.shown === 'lt3' ? (prev?.below ?? gen) : undefined;
  const next: PointState = { ...h.next };
  if (below !== undefined) next.below = below;
  if (prev?.ep) next.ep = 1;
  return { shown: h.shown, valid, below, next };
}

export type AlertKind = 'alert3' | 'alert4' | 'clear';
export interface FollowState { alerted: 0 | 3 | 4; lastAlertAt: string | null; lastL4At: string | null; lastClearAt: string | null }
export interface Decision { kind: AlertKind | null; next: FollowState; changed: boolean; quietUntil: string | null }

const minutesSince = (from: string | null, now: string): number =>
  (from === null ? Infinity : (Date.parse(now) - Date.parse(from)) / 60e3);

/** The per-follower table of spec §5.3. `now` is the snapshot time. */
export function decideFollow(f: FollowState, p: Pick<PointStep, 'shown' | 'valid' | 'below'>, now: string): Decision {
  const none: Decision = { kind: null, next: f, changed: false, quietUntil: null };
  if (!p.valid || p.shown === null || p.shown === 0) return none;

  if (p.shown === 4 && f.alerted !== 4 && minutesSince(f.lastL4At, now) >= ALERT.level4MinGapMin) {
    return { kind: 'alert4', next: { ...f, alerted: 4, lastAlertAt: now, lastL4At: now }, changed: true, quietUntil: null };
  }
  if (p.shown === 3 || p.shown === 4) {
    if (f.alerted === 0) {
      // Also the row for shown=4 held back by the 60-minute gap (spec §5.3 note).
      if (minutesSince(f.lastAlertAt, now) >= ALERT.repeatH * 60) {
        return { kind: 'alert3', next: { ...f, alerted: 3, lastAlertAt: now }, changed: true, quietUntil: null };
      }
      return none;
    }
    if (p.shown === 3 && f.alerted === 4) return { kind: null, next: { ...f, alerted: 3 }, changed: true, quietUntil: null };
    return none;
  }
  // shown 'lt3'
  if (f.alerted !== 0 && p.below !== undefined && minutesSince(p.below, now) >= ALERT.clearHoldMin) {
    const quietEnd = f.lastAlertAt === null ? NaN : Date.parse(f.lastAlertAt) + ALERT.repeatH * 3600e3;
    return {
      kind: 'clear', next: { ...f, alerted: 0, lastClearAt: now }, changed: true,
      quietUntil: quietEnd > Date.parse(now) ? new Date(quietEnd).toISOString() : null,
    };
  }
  return none;
}
