import { setImmediate as yieldNow } from 'node:timers/promises';
import { ALERT } from '../core/alert-config';
import { decideFollow, stepPoint, type AlertKind, type FollowState, type PointState, type PointStep } from '../core/alert-rule';
import { alertMessage, clearMessage, type AlertMessage } from '../core/alert-text';
import { HOLD_MS } from '../core/hysteresis';
import { assessPoint, type Assessment } from '../core/risk';
import type { AlertStateBlob, FollowRow, FollowUpdate, PlaceRow } from './repo';
import { inputAt, type Snapshot } from './snapshot';
export type { AlertStateBlob } from './repo';

export interface PointEval { step: PointStep; a: Assessment | null; joined: boolean }
type EvalCounts = { valid: number; shown3: number; shown4: number; gap: number };
interface EvalAcc { points: Map<string, PointEval>; next: Record<string, PointState>; counts: EvalCounts; prevGen: string | null; gap: boolean }

function startEval(snap: Snapshot, prev: AlertStateBlob | null): EvalAcc {
  const prevGen = prev?.gen ?? null;
  // Data gap (I1): runs that evaluated nothing wrote no state, so `below` would span data we never
  // saw. Restart every clock; l3/l4 (card hysteresis) and ep stay.
  const gap = snap.ok && prevGen !== null && (Date.parse(snap.gen) - Date.parse(prevGen)) / 60e3 > ALERT.maxSnapshotAgeMin;
  return { points: new Map(), next: {}, counts: { valid: 0, shown3: 0, shown4: 0, gap: gap ? 1 : 0 }, prevGen, gap };
}

function stepEval(acc: EvalAcc, snap: Snapshot, prev: AlertStateBlob | null, p: PlaceRow): void {
  let before = prev?.places[p.k];
  if (acc.gap && before?.below !== undefined) {
    before = { ...before };
    delete before.below;
  }
  let a: Assessment | null = null;
  let step: PointStep;
  if (snap.ok) {
    const input = inputAt(snap, p.lat, p.lon);
    a = assessPoint(p.lat, p.lon, input);
    step = stepPoint(before, { snapshotOk: true, raw: a.level, incomplete: !!input.incomplete }, snap.gen);
  } else {
    step = stepPoint(before, { snapshotOk: false }, snap.gen);
  }
  const joined = acc.prevGen !== null && before?.l3 !== undefined && Date.parse(before.l3) >= Date.parse(acc.prevGen) - HOLD_MS;
  acc.points.set(p.k, { step, a, joined });
  if (step.valid) acc.counts.valid++;
  if (step.valid && step.shown === 3) acc.counts.shown3++;
  if (step.valid && step.shown === 4) acc.counts.shown4++;
  if (Object.keys(step.next).length) acc.next[p.k] = step.next;
}

function finishEval(acc: EvalAcc, snap: Snapshot): { points: Map<string, PointEval>; blob: AlertStateBlob; counts: EvalCounts } {
  return { points: acc.points, blob: { v: 1, gen: snap.ok ? snap.gen : (acc.prevGen ?? snap.gen), places: acc.next }, counts: acc.counts };
}

export function evaluatePoints(snap: Snapshot, places: PlaceRow[], prev: AlertStateBlob | null): ReturnType<typeof finishEval> {
  const acc = startEval(snap, prev);
  for (const p of places) stepEval(acc, snap, prev, p);
  return finishEval(acc, snap);
}

/** The same, giving the event loop back every `every` places so the 30-second heartbeat timer of
 *  the alerts process keeps beating during a 100,000-place evaluation (spec §4.3). */
export async function evaluatePointsYielding(snap: Snapshot, places: PlaceRow[], prev: AlertStateBlob | null, every = 1000): Promise<ReturnType<typeof finishEval>> {
  const acc = startEval(snap, prev);
  for (let i = 0; i < places.length; i++) {
    stepEval(acc, snap, prev, places[i]!);
    if ((i + 1) % every === 0) await yieldNow();
  }
  return finishEval(acc, snap);
}

/** Places whose followers can get a message this run (spec §5.1 step 5). */
export function keysToQuery(points: Map<string, PointEval>, gen: string): string[] {
  const out: string[] = [];
  for (const [k, { step }] of points) {
    if (!step.valid) continue;
    if (step.shown === 3 || step.shown === 4) out.push(k);
    else if (step.shown === 'lt3' && step.next.ep && step.below !== undefined && (Date.parse(gen) - Date.parse(step.below)) / 60e3 >= ALERT.clearHoldMin) out.push(k);
  }
  return out;
}

export interface Planned { f: FollowRow; kind: AlertKind | null; next: FollowState; msg: AlertMessage | null }
const RANK: Record<AlertKind, number> = { alert4: 0, alert3: 1, clear: 2 };

export function planFollows(follows: FollowRow[], points: Map<string, PointEval>, gen: string): Planned[] {
  const out: Planned[] = [];
  for (const f of follows) {
    const e = points.get(f.key);
    if (!e || !e.a) continue;
    const d = decideFollow({ alerted: f.alerted, lastAlertAt: f.lastAlertAt, lastL4At: f.lastL4At, lastClearAt: f.lastClearAt }, e.step, gen);
    if (!d.changed) continue;
    let msg: AlertMessage | null = null;
    if (d.kind === 'alert3' || d.kind === 'alert4') msg = alertMessage(e.step.shown as 3 | 4, e.a, gen, e.joined);
    else if (d.kind === 'clear') msg = clearMessage(e.a.level as 1 | 2, gen, d.quietUntil);
    out.push({ f, kind: d.kind, next: d.next, msg });
  }
  return out.sort((x, y) => (x.kind ? RANK[x.kind] : 3) - (y.kind ? RANK[y.kind] : 3));
}

/** Per-run caps (spec §5.1 step 6). Over the cap, or on a channel that is off: not sent and not
 *  recorded, so the next run re-evaluates with a newer snapshot. */
export function capPlanned(planned: Planned[], caps: { push: number; tg: number }, channels: { push: boolean; tg: boolean }): { send: Planned[]; stateOnly: Planned[]; deferred: number } {
  const used = { push: 0, tg: 0 };
  const send: Planned[] = [];
  const stateOnly: Planned[] = [];
  let deferred = 0;
  for (const p of planned) {
    if (!p.kind) { stateOnly.push(p); continue; }
    if (!channels[p.f.ch] || used[p.f.ch] >= caps[p.f.ch]) { deferred++; continue; }
    used[p.f.ch]++;
    send.push(p);
  }
  return { send, stateOnly, deferred };
}

export const toUpdate = (p: Planned): FollowUpdate => ({ fid: p.f.fid, alerted: p.next.alerted, lastAlertAt: p.next.lastAlertAt, lastL4At: p.next.lastL4At, lastClearAt: p.next.lastClearAt });

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
