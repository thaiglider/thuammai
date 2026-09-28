// The spike's scoring method (docs/research/backtest/2026-09-28-spike.mjs), shared by the CI
// regression backtest and the daily evaluation so the two can never measure differently.
import { distKm, type LatLon } from './geo';
import { LEVEL_KEYS, SIGNAL_SETS, TRUTHS, type LevelKey, type Matrix, type SignalSet, type Truth } from './skill';

export interface Tally {
  /** truth instances, and how many were assessed ≥k (hit rate) */
  hD: number; hN: number;
  /** population units assessed ≥k, and how many of those were true (precision) */
  pD: number; pN: number;
  /** population units, and how many were true (base rate) */
  bD: number; bN: number;
}
export const emptyTally = (): Tally => ({ hD: 0, hN: 0, pD: 0, pN: 0, bD: 0, bN: 0 });
export const addTally = (a: Tally, b: Tally): Tally =>
  ({ hD: a.hD + b.hD, hN: a.hN + b.hN, pD: a.pD + b.pD, pN: a.pN + b.pN, bD: a.bD + b.bD, bN: a.bN + b.bN });

export function tallyOf(truthLevels: readonly number[], popLevels: readonly number[], popTruth: readonly boolean[], k: number): Tally {
  if (popLevels.length !== popTruth.length) throw new Error(`popLevels/popTruth length mismatch (${popLevels.length} vs ${popTruth.length})`);
  const t = emptyTally();
  t.hD = truthLevels.length;
  t.hN = truthLevels.filter((l) => l >= k).length;
  popLevels.forEach((l, i) => {
    const truth = popTruth[i]!;
    t.bD++;
    if (truth) t.bN++;
    if (l >= k) {
      t.pD++;
      if (truth) t.pN++;
    }
  });
  return t;
}

export interface Ratios { hit: number | null; prec: number | null; base: number | null; lift: number | null }

/** hit = hN/hD, precision = pN/pD, base rate = bN/bD, lift = precision ÷ base rate; null below minN. */
export function ratios(t: Tally, minN: number): Ratios {
  const hit = t.hD >= minN ? t.hN / t.hD : null;
  const prec = t.pD >= minN ? t.pN / t.pD : null;
  const base = t.bD >= minN && t.bN > 0 ? t.bN / t.bD : null;
  const lift = prec !== null && base !== null ? prec / base : null;
  return { hit, prec, base, lift };
}

/** The spike's control grid: stepDeg points inside bbox closer than nearKm to any anchor. The loop
 *  accumulates floats exactly like the spike so the grid (and the backtest numbers) stay identical. */
export function evalGrid(anchors: readonly LatLon[], bbox: { s: number; n: number; w: number; e: number }, stepDeg: number, nearKm: number): LatLon[] {
  const grid: LatLon[] = [];
  if (!anchors.length) return grid;
  for (let lat = bbox.s; lat < bbox.n; lat += stepDeg)
    for (let lon = bbox.w; lon < bbox.e; lon += stepDeg)
      if (anchors.some((o) => distKm(lat, lon, o.lat, o.lon) < nearKm)) grid.push({ lat, lon });
  return grid;
}

export function nearAny(p: LatLon, pts: readonly LatLon[], km: number): boolean {
  return pts.some((g) => distKm(p.lat, p.lon, g.lat, g.lon) <= km);
}

export type TallySet = Matrix<Tally>;

function build<T>(f: (truth: Truth, set: SignalSet, k: LevelKey) => T): Matrix<T> {
  const out = {} as Matrix<T>;
  for (const tr of TRUTHS) {
    const bySet = {} as Record<SignalSet, Record<LevelKey, T>>;
    for (const s of SIGNAL_SETS) {
      const byK = {} as Record<LevelKey, T>;
      for (const k of LEVEL_KEYS) byK[k] = f(tr, s, k);
      bySet[s] = byK;
    }
    out[tr] = bySet;
  }
  return out;
}

export const emptyTallySet = (): TallySet => build(() => emptyTally());
export const mapTallySet = <T>(ts: TallySet, f: (t: Tally) => T): Matrix<T> => build((tr, s, k) => f(ts[tr][s][k]));
export function addTallySet(acc: TallySet, b: TallySet): void {
  for (const tr of TRUTHS) for (const s of SIGNAL_SETS) for (const k of LEVEL_KEYS) acc[tr][s][k] = addTally(acc[tr][s][k], b[tr][s][k]);
}
