// Scores one hourly snapshot with the spike method against two ground truths (spec §7):
// flood reports (history._events) and road sensors (≥10 cm for ≥1 h, leave-one-station-out).
import type { CompactEvent, Sample } from '../core/history';
import { assessPoint, type RiskInput } from '../core/risk';
import { LEVEL_KEYS, SIGNAL_SETS, TRUTHS, type Matrix, type SignalSet, type Truth } from '../core/skill';
import { addTallySet, emptyTallySet, evalGrid, mapTallySet, nearAny, tallyOf, type TallySet } from '../core/skill-score';
import { distKm } from '../core/geo';
import { CORROB, EVAL, EVENT_AGE_H, ROAD } from '../core/thresholds';
import type { Observation } from '../core/types';
import { replayObs, type EvalLog, type EvalSnap } from './eval-log';

const MIN = 60e3;

function inBox(lat: number, lon: number): boolean {
  const b = EVAL.bbox;
  return lat > b.s && lat < b.n && lon > b.w && lon < b.e;
}

/** Reports that stand for "flooded here at T": iTIC/public Longdo and Traffy (not highway, as in the
 *  spike), inside the box, no older than their reporter's age limit, filed at most 60 min after T. */
export function activeReports(events: readonly CompactEvent[], T: number): CompactEvent[] {
  return events.filter((e) => e.r !== 'highway' && inBox(e.lat, e.lon)
    && e.t <= T + EVAL.reportLeadMin * MIN && T - e.t <= EVENT_AGE_H[e.r] * 3600e3);
}

/** 'wet' = a run of consecutive readings ≥ roadWetCm spanning ≥ roadWetMin that overlaps T ± roadTruthMin;
 *  'dry' = a reading exists within T ± roadTruthMin but no such run; null = no reading near T.
 *  Readings outside 0..ROAD.max (e.g. 999) are invalid and ignored, like the collector does
 *  (sources/thaiwater.ts) — a defence in depth for history written by other code paths. */
export function roadTruth(series: readonly Sample[] | undefined, T: number): 'wet' | 'dry' | null {
  if (!series?.length) return null;
  const near = EVAL.roadTruthMin * MIN;
  const look = EVAL.roadLookMin * MIN;
  const w = series.filter((x) => x.t >= T - look && x.t <= T + look && Number.isFinite(x.v) && x.v >= 0 && x.v <= ROAD.max);
  if (!w.some((x) => Math.abs(x.t - T) <= near)) return null;
  let start = -1;
  for (let i = 0; i <= w.length; i++) {
    const isWet = i < w.length && w[i]!.v >= EVAL.roadWetCm;
    if (isWet && start < 0) start = i;
    if (!isWet && start >= 0) {
      const a = w[start]!.t;
      const b = w[i - 1]!.t;
      if (b - a >= EVAL.roadWetMin * MIN && a <= T + near && b >= T - near) return 'wet';
      start = -1;
    }
  }
  return 'dry';
}

/** The judged sensor itself, or a road sensor so close it is not independent evidence. */
export const isTwin = (x: Observation, judged: Observation): boolean =>
  x.id === judged.id || (x.kind === 'road' && distKm(x.lat, x.lon, judged.lat, judged.lon) <= CORROB.independentKm);

/** Distinct independent units behind a day's tallies (EVAL.minTruthUnits / minFlagUnits):
 *  `truth` = report ids (reports) / wet sensor ids (road); `flag[truth][set][k]` = warned places,
 *  0.01° grid keys (reports) / sensor ids (road). */
export interface DayUnits { truth: Record<Truth, string[]>; flag: Matrix<string[]> }
export interface UnitSets { truth: Record<Truth, Set<string>>; flag: Matrix<Set<string>> }
export const emptyUnitSets = (): UnitSets =>
  ({ truth: { reports: new Set(), road: new Set() }, flag: mapTallySet(emptyTallySet(), () => new Set<string>()) });
export function unitsOf(u: UnitSets): DayUnits {
  const sorted = (x: Set<string>) => [...x].sort();
  const flag = mapTallySet(emptyTallySet(), () => [] as string[]);
  for (const t of TRUTHS) for (const g of SIGNAL_SETS) for (const k of LEVEL_KEYS) flag[t][g][k] = sorted(u.flag[t][g][k]);
  return { truth: { reports: sorted(u.truth.reports), road: sorted(u.truth.road) }, flag };
}
const gridKey = (p: { lat: number; lon: number }) =>
  `${Math.round((p.lat - EVAL.bbox.s) / EVAL.gridStepDeg)}_${Math.round((p.lon - EVAL.bbox.w) / EVAL.gridStepDeg)}`;

const only = (obs: readonly Observation[], set: SignalSet): Observation[] => (set === 'all' ? [...obs] : obs.filter((o) => o.kind === set));

/** Tallies of one snapshot; when `units` is given, also adds the distinct units behind them. */
export function scoreSnapshot(log: EvalLog, snap: EvalSnap, events: readonly CompactEvent[], series: Readonly<Record<string, Sample[]>>, units?: UnitSets): TallySet {
  const obs = replayObs(log, snap);
  const now = new Date(snap.t);
  const input = (o: Observation[]): RiskInput => ({ obs: o, events: [], forecast: [], rain0: [], now });
  const out = emptyTallySet();

  const reports = activeReports(events, snap.t);
  const grid = evalGrid(obs.filter((o) => o.kind === 'road' || o.kind === 'canal'), EVAL.bbox, EVAL.gridStepDeg, EVAL.gridNearKm);
  const gridTruth = grid.map((p) => nearAny(p, reports, EVAL.truthKm));
  const stuck = new Set((snap.k ?? []).map((i) => log.stations[i]?.id));
  const roads = obs
    .filter((o) => o.kind === 'road' && inBox(o.lat, o.lon) && !stuck.has(o.id))
    .map((o) => ({ o, truth: roadTruth(series[o.id], snap.t) }))
    .filter((x): x is { o: Observation; truth: 'wet' | 'dry' } => x.truth !== null);
  const roadWet = roads.map((x) => x.truth === 'wet');
  if (units) {
    for (const e of reports) units.truth.reports.add(e.id);
    roads.forEach((x, i) => { if (roadWet[i]) units.truth.road.add(x.o.id); });
  }

  for (const set of SIGNAL_SETS) {
    const setObs = only(obs, set);
    const full = input(setObs);
    const reportLevels = reports.map((e) => assessPoint(e.lat, e.lon, full).level);
    const gridLevels = grid.map((p) => assessPoint(p.lat, p.lon, full).level);
    // leave-one-station-out: neither the sensor being judged nor a road sensor within
    // CORROB.independentKm of it (the engine's own "not independent" distance — a near twin
    // would otherwise confirm it at full strength) is an input to its own assessment
    const roadLevels = roads.map(({ o }) => assessPoint(o.lat, o.lon, input(setObs.filter((x) => !isTwin(x, o)))).level);
    const wetLevels = roadLevels.filter((_, i) => roadWet[i]);
    for (const k of LEVEL_KEYS) {
      out.reports[set][k] = tallyOf(reportLevels, gridLevels, gridTruth, Number(k));
      out.road[set][k] = tallyOf(wetLevels, roadLevels, roadWet, Number(k));
      if (units) {
        grid.forEach((p, i) => { if (gridLevels[i]! >= Number(k)) units.flag.reports[set][k].add(gridKey(p)); });
        roads.forEach((x, i) => { if (roadLevels[i]! >= Number(k)) units.flag.road[set][k].add(x.o.id); });
      }
    }
  }
  return out;
}

export function evaluateDay(log: EvalLog, events: readonly CompactEvent[], series: Readonly<Record<string, Sample[]>>, fromMs: number, toMs: number): { snaps: number; tallies: TallySet; units: DayUnits } {
  const tallies = emptyTallySet();
  const units = emptyUnitSets();
  let snaps = 0;
  for (const snap of log.snaps) {
    if (snap.t < fromMs || snap.t >= toMs) continue;
    addTallySet(tallies, scoreSnapshot(log, snap, events, series, units));
    snaps++;
  }
  return { snaps, tallies, units: unitsOf(units) };
}
