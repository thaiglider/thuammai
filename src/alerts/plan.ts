import { ALERT } from '../core/alert-config';
import { decideFollow, stepPoint, type AlertKind, type FollowState, type PointState, type PointStep } from '../core/alert-rule';
import { alertMessage, clearMessage, type AlertMessage } from '../core/alert-text';
import { HOLD_MS } from '../core/hysteresis';
import { assessPoint, type Assessment } from '../core/risk';
import { inputAt, type Snapshot } from './snapshot';
import type { FollowRow, FollowUpdate, PlaceRow } from './worker-client';

/** Place-level alert state (spec §3), one opaque kv row written once per run. */
export interface AlertStateBlob { v: 1; gen: string; places: Record<string, PointState> }
export const BLOB_MAX_BYTES = 900_000;

export function parseBlob(value: string | null): AlertStateBlob | null {
  if (!value) return null;
  try {
    const b = JSON.parse(value) as AlertStateBlob;
    return b && b.v === 1 && typeof b.gen === 'string' && typeof b.places === 'object' && b.places !== null && !Array.isArray(b.places) ? b : null;
  } catch {
    return null;
  }
}

/** Serialise within `max` bytes: drop places without an episode first (their hysteresis just
 *  restarts — never a wrong clear, since `below` must build up again), then hysteresis times of
 *  episode places (keeping ep/below). */
export function packBlob(b: AlertStateBlob, max = BLOB_MAX_BYTES): string {
  const bytes = (x: AlertStateBlob) => Buffer.byteLength(JSON.stringify(x));
  if (bytes(b) <= max) return JSON.stringify(b);
  const places: Record<string, PointState> = { ...b.places };
  const out: AlertStateBlob = { ...b, places };
  let total = bytes(b);
  for (const k of Object.keys(places)) {
    if (total <= max) break;
    if (places[k]!.ep) continue;
    total -= Buffer.byteLength(JSON.stringify({ [k]: places[k] })) - 1; // `"k":{…},` in the full object
    delete places[k];
  }
  if (bytes(out) <= max) return JSON.stringify(out);
  for (const k of Object.keys(places)) if (!places[k]!.ep) delete places[k];
  for (const k of Object.keys(places)) {
    const p = places[k]!;
    places[k] = { ep: 1, ...(p.below ? { below: p.below } : {}) };
  }
  return JSON.stringify(out);
}

/** After a 409 on PUT state (spec §5.1 step 9): a newer writer wins (null = do not write). */
export function mergeForRetry(theirs: AlertStateBlob | null, ours: AlertStateBlob): AlertStateBlob | null {
  if (theirs && Date.parse(theirs.gen) > Date.parse(ours.gen)) return null;
  return ours;
}

export interface PointEval { step: PointStep; a: Assessment | null; joined: boolean }

export function evaluatePoints(snap: Snapshot, places: PlaceRow[], prev: AlertStateBlob | null): {
  points: Map<string, PointEval>; blob: AlertStateBlob; counts: { valid: number; shown3: number; shown4: number; gap: number };
} {
  const points = new Map<string, PointEval>();
  const next: Record<string, PointState> = {};
  const counts = { valid: 0, shown3: 0, shown4: 0, gap: 0 };
  const prevGen = prev?.gen ?? null;
  // Data gap (I1): runs that evaluated nothing (Worker down, D1 quota, error, timeout, alerts
  // switched off) wrote no state, so `below` would span data we never saw. Restart every clock;
  // l3/l4 (card hysteresis) and ep stay.
  const gap = snap.ok && prevGen !== null && (Date.parse(snap.gen) - Date.parse(prevGen)) / 60e3 > ALERT.maxSnapshotAgeMin;
  if (gap) counts.gap = 1;
  for (const p of places) {
    let before = prev?.places[p.k];
    if (gap && before?.below !== undefined) {
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
    const joined = prevGen !== null && before?.l3 !== undefined && Date.parse(before.l3) >= Date.parse(prevGen) - HOLD_MS;
    points.set(p.k, { step, a, joined });
    if (step.valid) counts.valid++;
    if (step.valid && step.shown === 3) counts.shown3++;
    if (step.valid && step.shown === 4) counts.shown4++;
    if (Object.keys(step.next).length) next[p.k] = step.next;
  }
  return { points, blob: { v: 1, gen: snap.ok ? snap.gen : (prevGen ?? snap.gen), places: next }, counts };
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
