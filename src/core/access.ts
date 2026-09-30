import { isFreshObs } from './fresh';
import { nearest } from './geo';
import { isLiveEvent, type RiskInput } from './risk';
import { ACCESS, VEHICLE_CM, type Vehicle } from './thresholds';
import { isWaterKind } from './trend';

export type { Vehicle } from './thresholds';
export type AccessStatus = 'blocked' | 'water' | 'clear' | 'unknown';
export interface Access {
  at: 'exit' | 'near'; status: AccessStatus; depthCm?: number; atLeast?: boolean; impassable: boolean;
  source?: { kind: 'road' | 'report'; name: string; km: number; at: string };
}
export interface Area { status: 'flooding' | 'watch' | 'quiet' | 'unknown'; flooded: number; watch: number; reports: number; stations: number; incomplete: boolean }
export type Pass = 'ok' | 'caution' | 'avoid' | 'unknown';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** What the road at (lat, lon) is like, from road-specific evidence only (spec §8.2). */
export function accessAt(lat: number, lon: number, input: RiskInput, at: 'exit' | 'near'): Access {
  if (input.incomplete) return { at, status: 'unknown', impassable: false };
  const sensors = input.obs.filter((o) => o.kind === 'road' && o.level > 0 && !o.held && !o.flags?.includes('stale')
    // an old reading may still warn (water/blocked) but never certify 'clear' or a low depth
    && (o.v >= ACCESS.waterCm || isFreshObs(o, input.now)));
  const sensor = nearest(sensors, lat, lon, ACCESS.sensorKm, 1)[0];
  const reports = nearest(input.events.filter((e) => isLiveEvent(e, input.now)), lat, lon, ACCESS.reportKm);
  const impassable = reports.some((x) => x.item.passable === false);

  let depthCm: number | undefined;
  let atLeast = false;
  let source: Access['source'];
  if (sensor) {
    depthCm = sensor.item.v;
    atLeast = !!sensor.item.flags?.includes('step5cm') && sensor.item.v >= 20;
    source = { kind: 'road', name: sensor.item.name, km: r2(sensor.km), at: sensor.item.t };
  }
  const deep = reports.filter((x) => (x.item.depthCm ?? 0) > 0).sort((a, b) => (b.item.depthCm ?? 0) - (a.item.depthCm ?? 0))[0];
  if (deep && (depthCm === undefined || deep.item.depthCm! > depthCm)) {
    depthCm = deep.item.depthCm!;
    atLeast = false;
    source = { kind: 'report', name: deep.item.title, km: r2(deep.km), at: deep.item.t };
  }
  if (!source && reports.length) {
    const r = reports[0]!;
    source = { kind: 'report', name: r.item.title, km: r2(r.km), at: r.item.t };
  }

  let status: AccessStatus = 'unknown';
  if (impassable || (depthCm !== undefined && depthCm >= ACCESS.blockedCm)) status = 'blocked';
  else if (depthCm !== undefined && depthCm >= ACCESS.waterCm) status = 'water';
  else if (sensor && reports.length === 0) status = 'clear';

  const out: Access = { at, status, impassable };
  if (depthCm !== undefined) {
    out.depthCm = depthCm;
    if (atLeast) out.atLeast = true;
    else if (source?.kind === 'report') out.atLeast = false;
  }
  if (source) out.source = source;
  return out;
}

/** The neighbourhood within ACCESS.areaKm, by each station's own level (spec §8.3). */
export function areaAround(lat: number, lon: number, input: RiskInput): Area {
  if (input.incomplete) return { status: 'unknown', flooded: 0, watch: 0, reports: 0, stations: 0, incomplete: true };
  const st = nearest(input.obs.filter((o) => isWaterKind(o.kind) && o.level > 0 && isFreshObs(o, input.now)), lat, lon, ACCESS.areaKm).map((x) => x.item);
  const reports = nearest(input.events.filter((e) => isLiveEvent(e, input.now)), lat, lon, ACCESS.areaKm).length;
  const flooded = st.filter((o) => o.level >= 3).length;
  const watch = st.filter((o) => o.level === 2).length;
  const status: Area['status'] = flooded >= 1 || reports >= 2 ? 'flooding'
    : watch >= 1 || reports === 1 ? 'watch'
      : st.length >= 1 ? 'quiet' : 'unknown';
  return { status, flooded, watch, reports, stations: st.length, incomplete: false };
}

export function passFor(v: Vehicle, a: Access): Pass {
  if (a.impassable) return 'avoid';
  if (a.depthCm === undefined) return a.status === 'clear' ? 'ok' : 'unknown';
  const t = VEHICLE_CM[v];
  if (a.depthCm >= t.avoid) return 'avoid';
  if (a.depthCm >= t.caution || a.atLeast) return 'caution';
  return 'ok';
}
