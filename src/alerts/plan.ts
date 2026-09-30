import { setImmediate as yieldNow } from 'node:timers/promises';
import { ALERT } from '../core/alert-config';
import { decideFollow, stepPoint, type AlertKind, type FollowState, type PointState, type PointStep } from '../core/alert-rule';
import { alertMessage, clearMessage, trendMessage, type AlertMessage } from '../core/alert-text';
import { HOLD_MS } from '../core/hysteresis';
import { assessPoint, type Assessment } from '../core/risk';
import { pointTrend, type Trend } from '../core/trend';
import { decideTrend, resetTrendOnAlert, stepTrend, trendHeld, type TrendFollow, type TrendKind } from '../core/trend-alert';
import type { AlertStateBlob, FollowRow, FollowUpdate, PlaceRow } from './repo';
import { inputAt, type Snapshot } from './snapshot';
export type { AlertStateBlob } from './repo';

/** `trend`: this snapshot's point trend (the card's pointTrend), only when it fed the trend run —
 *  a usable snapshot, a valid step, no data gap, trend alerts on; else null/absent. */
export interface PointEval { step: PointStep; a: Assessment | null; joined: boolean; trend?: Trend | null }
type EvalCounts = { valid: number; shown3: number; shown4: number; gap: number };
interface EvalAcc { points: Map<string, PointEval>; next: Record<string, PointState>; counts: EvalCounts; prevGen: string | null; gap: boolean; trendOn: boolean }

function startEval(snap: Snapshot, prev: AlertStateBlob | null, trendOn: boolean): EvalAcc {
  const prevGen = prev?.gen ?? null;
  // Data gap (I1): runs that evaluated nothing wrote no state, so `below` would span data we never
  // saw. Restart every clock; l3/l4 (card hysteresis) and ep stay.
  const gap = snap.ok && prevGen !== null && (Date.parse(snap.gen) - Date.parse(prevGen)) / 60e3 > ALERT.maxSnapshotAgeMin;
  return { points: new Map(), next: {}, counts: { valid: 0, shown3: 0, shown4: 0, gap: gap ? 1 : 0 }, prevGen, gap, trendOn };
}

function stepEval(acc: EvalAcc, snap: Snapshot, prev: AlertStateBlob | null, p: PlaceRow): void {
  let before = prev?.places[p.k];
  if (acc.gap && before?.below !== undefined) {
    before = { ...before };
    delete before.below;
  }
  let a: Assessment | null = null;
  let step: PointStep;
  let trend: Trend | null = null;
  if (snap.ok) {
    const input = inputAt(snap, p.lat, p.lon);
    a = assessPoint(p.lat, p.lon, input);
    step = stepPoint(before, { snapshotOk: true, raw: a.level, incomplete: !!input.incomplete }, snap.gen);
    // Same input as the assessment (and the card). A data gap or an invalid step feeds no trend.
    if (acc.trendOn && step.valid && !acc.gap) trend = pointTrend(a, input.obs, input.now);
  } else {
    step = stepPoint(before, { snapshotOk: false }, snap.gen);
  }
  // stepPoint does not manage tr/trSince: they are set here, every time. With trend alerts off no
  // trend is evaluated and the run is cleared, so turning them on again needs a real 30-minute
  // hold (spec §4).
  delete step.next.tr;
  delete step.next.trSince;
  const tp = stepTrend(before, trend, snap.gen);
  if (tp.tr !== undefined && tp.trSince !== undefined) {
    step.next.tr = tp.tr;
    step.next.trSince = tp.trSince;
  }
  const joined = acc.prevGen !== null && before?.l3 !== undefined && Date.parse(before.l3) >= Date.parse(acc.prevGen) - HOLD_MS;
  acc.points.set(p.k, { step, a, joined, trend });
  if (step.valid) acc.counts.valid++;
  if (step.valid && step.shown === 3) acc.counts.shown3++;
  if (step.valid && step.shown === 4) acc.counts.shown4++;
  if (Object.keys(step.next).length) acc.next[p.k] = step.next;
}

function finishEval(acc: EvalAcc, snap: Snapshot): { points: Map<string, PointEval>; blob: AlertStateBlob; counts: EvalCounts } {
  return { points: acc.points, blob: { v: 1, gen: snap.ok ? snap.gen : (acc.prevGen ?? snap.gen), places: acc.next }, counts: acc.counts };
}

export function evaluatePoints(snap: Snapshot, places: PlaceRow[], prev: AlertStateBlob | null, trendOn = true): ReturnType<typeof finishEval> {
  const acc = startEval(snap, prev, trendOn);
  for (const p of places) stepEval(acc, snap, prev, p);
  return finishEval(acc, snap);
}

/** The same, giving the event loop back every `every` places so the 30-second heartbeat timer of
 *  the alerts process keeps beating during a 100,000-place evaluation (spec §4.3). */
export async function evaluatePointsYielding(snap: Snapshot, places: PlaceRow[], prev: AlertStateBlob | null, every = 1000, trendOn = true): Promise<ReturnType<typeof finishEval>> {
  const acc = startEval(snap, prev, trendOn);
  for (let i = 0; i < places.length; i++) {
    stepEval(acc, snap, prev, places[i]!);
    if ((i + 1) % every === 0) await yieldNow();
  }
  return finishEval(acc, snap);
}

/** Places whose followers can get a message this run (spec §5.1 step 5). Trend alerts (H4 §3):
 *  "falling"/"rising again" need shown ≥3, so those places are asked already; below 3 only a held
 *  "fast" run can send ("rising fast"), so those places are asked too. */
export function keysToQuery(points: Map<string, PointEval>, gen: string, trendOn = true): string[] {
  const out: string[] = [];
  for (const [k, { step }] of points) {
    if (!step.valid) continue;
    if (step.shown === 3 || step.shown === 4) out.push(k);
    else if (step.shown === 'lt3' && step.next.ep && step.below !== undefined && (Date.parse(gen) - Date.parse(step.below)) / 60e3 >= ALERT.clearHoldMin) out.push(k);
    else if (trendOn && step.shown === 'lt3' && trendHeld(step.next, gen) === 'fast') out.push(k);
  }
  return out;
}

export type PlannedKind = AlertKind | TrendKind;
export type PlannedState = FollowState & TrendFollow;
/** `base` (trends only): a level-state change of this same run (e.g. alerted 4 → 3) with the stored
 *  trend fields — it must be written whether or not the trend goes out (capPlanned). */
export interface Planned { f: FollowRow; kind: PlannedKind | null; next: PlannedState; msg: AlertMessage | null; base?: PlannedState }
/** alert4 > alert3 > clear > trend (H4 §2.2), then state-only changes. */
const RANK: Record<PlannedKind, number> = { alert4: 0, alert3: 1, clear: 2, trend_fall: 3, trend_rise: 3, trend_fast: 3 };
export const isTrendKind = (k: PlannedKind | null): k is TrendKind => k === 'trend_fall' || k === 'trend_rise' || k === 'trend_fast';

/** Per follower: the level rules first; only when they send nothing, the trend rules (never on
 *  LINE, never with trend alerts off). An alert or clear sent this run resets the trend note. */
export function planFollows(follows: FollowRow[], points: Map<string, PointEval>, gen: string, trendOn = true): Planned[] {
  const out: Planned[] = [];
  for (const f of follows) {
    const e = points.get(f.key);
    if (!e || !e.a) continue;
    const d = decideFollow({ alerted: f.alerted, lastAlertAt: f.lastAlertAt, lastL4At: f.lastL4At, lastClearAt: f.lastClearAt }, e.step, gen);
    // Rows from before 0005 (or written by an older image) read as no note.
    const was: TrendFollow = { trendNote: f.trendNote ?? null, trendAt: f.trendAt ?? null };
    if (d.kind !== null) {
      // LINE never takes part in trends: its trend fields stay exactly as stored.
      const tf = f.ch === 'line' ? was : resetTrendOnAlert(was);
      const msg = d.kind === 'clear' ? clearMessage(e.a.level as 1 | 2, gen, d.quietUntil) : alertMessage(e.step.shown as 3 | 4, e.a, gen, e.joined);
      out.push({ f, kind: d.kind, next: { ...d.next, ...tf }, msg });
      continue;
    }
    if (trendOn && f.ch !== 'line' && e.trend) {
      const t = decideTrend({ alerted: d.next.alerted, lastAlertAt: d.next.lastAlertAt, ...was }, { shown: e.step.shown, valid: e.step.valid, raw: e.a.level, held: trendHeld(e.step.next, gen), station: e.trend.kind }, gen);
      if (t.kind !== null) {
        const shown = e.step.shown === 3 || e.step.shown === 4 ? e.step.shown : e.a.level;
        const p: Planned = { f, kind: t.kind, next: { ...d.next, ...t.next }, msg: trendMessage(t.kind, e.trend, shown, gen) };
        if (d.changed) p.base = { ...d.next, ...was };
        out.push(p);
        continue;
      }
    }
    if (d.changed) out.push({ f, kind: null, next: { ...d.next, ...was }, msg: null });
  }
  return out.sort((x, y) => (x.kind ? RANK[x.kind] : 4) - (y.kind ? RANK[y.kind] : 4));
}

/** Per-run caps (spec §5.1 step 6). Over the cap, or on a channel that is off: not sent and not
 *  recorded, so the next run re-evaluates with a newer snapshot. A trend carrying a level-state
 *  change (`base`) also yields that change as state-only — written before any send (main.ts), so
 *  it commits whether the trend is sent, deferred or fails; a sent trend then overwrites it. */
export function capPlanned(planned: Planned[], caps: { push: number; tg: number; line: number }, channels: { push: boolean; tg: boolean; line: boolean }): { send: Planned[]; stateOnly: Planned[]; deferred: number } {
  const used = { push: 0, tg: 0, line: 0 };
  const send: Planned[] = [];
  const stateOnly: Planned[] = [];
  let deferred = 0;
  for (const p of planned) {
    if (!p.kind) { stateOnly.push(p); continue; }
    if (p.base) stateOnly.push({ f: p.f, kind: null, next: p.base, msg: null });
    if (!channels[p.f.ch] || used[p.f.ch] >= caps[p.f.ch]) { deferred++; continue; }
    used[p.f.ch]++;
    send.push(p);
  }
  return { send, stateOnly, deferred };
}

export const toUpdate = (p: Planned): FollowUpdate => ({ fid: p.f.fid, alerted: p.next.alerted, lastAlertAt: p.next.lastAlertAt, lastL4At: p.next.lastL4At, lastClearAt: p.next.lastClearAt, trendNote: p.next.trendNote, trendAt: p.next.trendAt });

/** ep of each queried place = some follower has alerted > 0 after this run (written state, or the
 *  old state for deferred/unchanged follows). Places not queried keep their ep. */
export function recomputeEp(blob: AlertStateBlob, queried: string[], follows: FollowRow[], written: Map<number, FollowState>): void {
  const inEpisode = new Set<string>();
  for (const f of follows) if ((written.get(f.fid)?.alerted ?? f.alerted) > 0) inEpisode.add(f.key);
  for (const k of queried) {
    const st: PointState = { ...(blob.places[k] ?? {}) };
    if (inEpisode.has(k)) st.ep = 1;
    else delete st.ep;
    if (Object.keys(st).length) blob.places[k] = st;
    else delete blob.places[k];
  }
}
