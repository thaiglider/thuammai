import { isFreshObs } from './fresh';
import type { Assessment, Reason } from './risk';
import { TREND } from './thresholds';
import type { Observation } from './types';

export type TrendState = 'rising' | 'stable' | 'falling' | 'mixed' | 'unknown';
export type WaterKind = 'road' | 'canal' | 'river';
export interface Trend {
  state: TrendState; cmPerH?: number; stationId?: string; name?: string; km?: number;
  kind?: WaterKind; tidal?: boolean; direct?: boolean;
}

export const isWaterKind = (k: string): k is WaterKind => k === 'road' || k === 'canal' || k === 'river';

/** Station trend in cm/h: river/canal slope3h is m/h, road slope3h is already cm/h. */
export function obsCmPerH(o: Observation): number | undefined {
  if (o.slope3h === undefined) return undefined;
  if (o.kind === 'road') return o.slope3h;
  if (o.kind === 'river' || o.kind === 'canal') return o.slope3h * 100;
  return undefined;
}

/** Water stations that decide the point (spec §5 rule 1), strongest first, then nearest. */
export function trendCandidates(a: Assessment): Reason[] {
  const floor = Math.max(1, a.level - 1);
  return a.reasons
    .filter((r) => isWaterKind(r.kind) && !r.far && r.level >= floor && r.stationId !== undefined)
    .sort((x, y) => y.level - x.level || x.km - y.km);
}

const classify = (c: number): 'rising' | 'stable' | 'falling' =>
  c >= TREND.stableCmH ? 'rising' : c <= -TREND.stableCmH ? 'falling' : 'stable';

export function pointTrend(a: Assessment, obs: readonly Observation[], now: Date): Trend {
  const byId = new Map(obs.map((o) => [o.id, o]));
  const rows: { r: Reason; o: Observation; c: number; s: ReturnType<typeof classify> }[] = [];
  for (const r of trendCandidates(a)) {
    const o = byId.get(r.stationId!);
    if (!o || o.held || !isFreshObs(o, now) || o.flags?.includes('erratic')) continue;
    const c = obsCmPerH(o);
    if (c === undefined) continue;
    rows.push({ r, o, c, s: classify(c) });
  }
  if (!rows.length) return { state: 'unknown' };
  const states = new Set(rows.map((x) => x.s));
  if (states.has('rising') && states.has('falling')) return { state: 'mixed' };
  const f = rows[0]!;
  return {
    state: f.s, cmPerH: Math.round(f.c) || 0, stationId: f.o.id, name: f.o.name, km: f.r.km,
    kind: f.o.kind as WaterKind, tidal: !!f.o.flags?.includes('tidal'), direct: f.r.direct,
  };
}
