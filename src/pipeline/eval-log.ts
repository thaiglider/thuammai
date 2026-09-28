// Hourly compact snapshots of the station levels that decide a level ≥2 assessment inside the
// evaluation box, kept in the pipeline state so evaluate.yml can replay them with assessPoint.
import { canalStressed } from '../core/risk';
import { EVAL, THRESHOLDS_VERSION } from '../core/thresholds';
import { toIso07 } from '../core/time';
import type { Level, Observation } from '../core/types';

export type EvalKind = 'road' | 'canal' | 'river' | 'rain';
export interface EvalStation { id: string; kind: EvalKind; lat: number; lon: number; prov: string }
/** One snapshot per clock hour: `t` = the pipeline run (epoch ms); each entry of `s` packs one
 *  station as `index × 10 + level × 2 + stressed` (index into `stations`; stressed = the canal state
 *  assessPoint step 3(ค) counts, replayed as the `backflow` flag). `k` = indices of road sensors the
 *  pipeline flagged `stuck` (frozen at a flood depth) — left out of the road truth; omitted if none. */
export interface EvalSnap { t: number; s: number[]; k?: number[] }
/** `thresholdsVersion` = the rules the snapshot levels were computed with (absent in logs written
 *  before it was added — treated as unknown, i.e. not the current rules). */
export interface EvalLog { v: 1; thresholdsVersion?: string; stations: EvalStation[]; snaps: EvalSnap[] }

const HOUR = 3600e3;
export const emptyEvalLog = (): EvalLog => ({ v: 1, thresholdsVersion: THRESHOLDS_VERSION, stations: [], snaps: [] });

export function isEvalLog(x: unknown): x is EvalLog {
  const l = x as EvalLog | null;
  if (!l || typeof l !== 'object' || l.v !== 1 || !Array.isArray(l.stations) || !Array.isArray(l.snaps)) return false;
  if (l.thresholdsVersion !== undefined && typeof l.thresholdsVersion !== 'string') return false;
  const isIndex = (i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < l.stations.length;
  return l.snaps.every((s) => {
    if (!s || typeof s.t !== 'number' || !Array.isArray(s.s)) return false;
    if (s.k !== undefined && !(Array.isArray(s.k) && s.k.every(isIndex))) return false;
    return s.s.every((c) => {
      if (!Number.isInteger(c) || c < 0) return false;
      const idx = Math.floor(c / 10);
      if (idx >= l.stations.length) return false;
      // The digit packs level×2+stressed. Kept stations are always level ≥1 (0 and dams are
      // never recorded — see `keep` below), so a digit decoding to level 0 is malformed, not
      // just a level/stressed encoding out of the packing's own 0–9 range.
      const digit = c % 10;
      const level = Math.floor(digit / 2);
      return level >= 1 && level <= 4;
    });
  });
}

/** The log if it is well formed AND its levels were computed under the current THRESHOLDS_VERSION;
 *  otherwise null (the pipeline then starts a new log, evaluate scores nothing from it) — replaying
 *  old-rule levels under the new version label would mix rules (plan ruling 5). */
export function currentEvalLog(x: unknown): EvalLog | null {
  return isEvalLog(x) && x.thresholdsVersion === THRESHOLDS_VERSION ? x : null;
}

function inReach(lat: number, lon: number): boolean {
  const { bbox: b, marginDeg: m } = EVAL;
  return lat > b.s - m && lat < b.n + m && lon > b.w - m && lon < b.e + m;
}

/** Every station assessPoint can use for a point in the box (level 0 and dams are never used). */
function keep(o: Observation): boolean {
  return o.level >= 1 && o.kind !== 'dam' && inReach(o.lat, o.lon);
}

/** Appends a snapshot unless one already exists for this clock hour (or a later one). */
export function recordSnapshot(log: EvalLog, obs: readonly Observation[], nowMs: number): boolean {
  const every = EVAL.snapEveryMin * 60e3;
  const last = log.snaps.at(-1);
  if (last && Math.floor(last.t / every) >= Math.floor(nowMs / every)) return false;
  const index = new Map(log.stations.map((s, i) => [s.id, i]));
  const s: number[] = [];
  const k: number[] = [];
  for (const o of obs) {
    if (!keep(o)) continue;
    const st: EvalStation = { id: o.id, kind: o.kind as EvalKind, lat: o.lat, lon: o.lon, prov: o.prov };
    let i = index.get(o.id);
    if (i === undefined) {
      i = log.stations.length;
      log.stations.push(st);
      index.set(o.id, i);
    } else {
      log.stations[i] = st; // a station whose metadata changed takes the latest values
    }
    s.push(i * 10 + o.level * 2 + (o.kind === 'canal' && canalStressed(o) ? 1 : 0));
    if (o.kind === 'road' && o.flags?.includes('stuck')) k.push(i);
  }
  log.snaps.push(k.length ? { t: nowMs, s, k } : { t: nowMs, s });
  return true;
}

/** Observations as assessPoint needs them for a ≥2 decision (values that only feed texts are 0/''). */
export function replayObs(log: EvalLog, snap: EvalSnap): Observation[] {
  const t = toIso07(new Date(snap.t));
  return snap.s.map((c) => {
    const st = log.stations[Math.floor(c / 10)]!;
    const level = Math.floor((c % 10) / 2) as Level;
    const o: Observation = { id: st.id, kind: st.kind, name: '', lat: st.lat, lon: st.lon, prov: st.prov, t, v: 0, level };
    if (c % 2 === 1) o.flags = ['backflow'];
    return o;
  });
}

/** Drops snapshots older than EVAL.keepH and stations no snapshot uses any more. */
export function pruneEvalLog(log: EvalLog, nowMs: number): void {
  log.snaps = log.snaps.filter((x) => x.t >= nowMs - EVAL.keepH * HOUR);
  const used = new Set<number>();
  for (const x of log.snaps) for (const c of x.s) used.add(Math.floor(c / 10));
  if (used.size === log.stations.length) return;
  const remap = new Map<number, number>();
  const stations: EvalStation[] = [];
  log.stations.forEach((st, i) => {
    if (!used.has(i)) return;
    remap.set(i, stations.length);
    stations.push(st);
  });
  for (const x of log.snaps) {
    x.s = x.s.map((c) => remap.get(Math.floor(c / 10))! * 10 + (c % 10));
    if (x.k) x.k = x.k.map((i) => remap.get(i)!);
  }
  log.stations = stations;
}
