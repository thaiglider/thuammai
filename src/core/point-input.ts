import { provincesNear } from './geo';
import type { RiskInput, ZeroRain } from './risk';
import type { FloodEvent, ForecastPoint, Observation, ProvinceGeo, Rain0 } from './types';

export interface ProvObsFile { generatedAt: string; obs: Observation[]; rain0: Rain0[] }
export interface EventsFile { generatedAt: string; windowH: number; events: FloodEvent[] }
export interface ForecastFile { generatedAt: string; points: ForecastPoint[] }
export type PointInput = RiskInput & { reportWindowH: number; olderSnapshotAt: string | null };

/** When files came from a different snapshot than meta.json — e.g. the service worker answered an
 *  obs request from its cache after a network timeout — return the oldest generatedAt involved
 *  (meta's own included); null when everything matches or meta is not known yet. */
export function snapshotMismatch(metaAt: string | null, fileAts: readonly (string | undefined)[]): string | null {
  if (!metaAt) return null;
  const all = [metaAt, ...fileAts.filter((a): a is string => typeof a === 'string')];
  if (all.every((a) => a === metaAt)) return null;
  return all.reduce((min, a) => (Date.parse(a) < Date.parse(min) ? a : min));
}

/** The provinces whose data can decide a point (bbox + 10 km), as the card has always used. */
export function pointProvinces(lat: number, lon: number, provinces: readonly ProvinceGeo[] | null): string[] {
  return provinces ? provincesNear(lat, lon, provinces, 10) : [];
}

/** The RiskInput for one point from already-loaded snapshot files (the card and the alerts job).
 *  A missing file, or files from different snapshots, mark the input incomplete so the level can
 *  never read as 1. */
export function buildPointInput(
  src: { provs: readonly string[]; obs: readonly (ProvObsFile | null)[]; events: EventsFile | null; forecast: ForecastFile | null },
  now: Date,
  metaAt: string | null,
): PointInput {
  const obs: Observation[] = [];
  const rain0: ZeroRain[] = [];
  const ats: string[] = [];
  let incomplete = !src.events || !src.forecast || src.provs.length === 0;
  if (src.events) ats.push(src.events.generatedAt);
  if (src.forecast) ats.push(src.forecast.generatedAt);
  src.provs.forEach((p, i) => {
    const f = src.obs[i];
    if (!f) { incomplete = true; return; }
    ats.push(f.generatedAt);
    obs.push(...f.obs);
    for (const [a, b] of f.rain0) rain0.push({ lat: a, lon: b, prov: p });
  });
  const olderSnapshotAt = snapshotMismatch(metaAt, ats);
  return {
    obs, rain0, now, incomplete: incomplete || olderSnapshotAt !== null, olderSnapshotAt,
    events: src.events?.events ?? [], forecast: src.forecast?.points ?? [], reportWindowH: src.events?.windowH ?? 0,
  };
}
