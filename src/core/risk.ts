import { distKm, hasIndependentPair, nearest } from './geo';
import { BKK_METRO, CONF, CORROB, DIST, EVENT_AGE_H, FORECAST, ITIC_URGENT_H, TRAFFY } from './thresholds';
import { ageMin, isTooFarInFuture } from './time';
import type { FloodEvent, ForecastPoint, Kind, Level, Observation, Reporter } from './types';

export type Family = 'water' | 'rain' | 'report' | 'forecast';
export type SignalKind = 'road' | 'canal' | 'river' | 'rain' | 'forecast' | 'longdo' | 'traffy';
export interface Reason {
  level: Level; family: Family; kind: SignalKind; direct: boolean; far?: boolean;
  km: number; at: string; lat: number; lon: number;
  stationId?: string; eventIds?: string[]; reporter?: Reporter; name?: string; held?: boolean;
  params: Record<string, number | string>;
}
export interface ZeroRain { lat: number; lon: number; prov: string }
export interface RiskInput {
  obs: readonly Observation[]; events: readonly FloodEvent[]; forecast: readonly ForecastPoint[];
  rain0: readonly ZeroRain[]; now: Date; incomplete?: boolean;
}
export type Headline = 'road' | 'waterway' | 'rain' | 'forecast' | 'none';
export interface Assessment {
  level: Level; confidence: 'high' | 'medium' | 'low'; basis: 'observed' | 'inferred' | 'forecast';
  headline: Headline; vehicleDepthCm?: number; reasons: Reason[];
  coverage: { water: 'near' | 'far' | 'none'; nearestWaterKm: number | null };
  raisedBy: ('independent' | 'families' | 'drainage')[]; incomplete: boolean; dataAt: string | null;
}

const clamp = (n: number): Level => Math.max(1, Math.min(4, n)) as Level;
const r2 = (n: number) => Math.round(n * 100) / 100;
const isWater = (k: SignalKind) => k === 'road' || k === 'canal' || k === 'river';
const FULL_KM: Partial<Record<Kind, number>> = { road: DIST.road.full, canal: DIST.canal.full, river: DIST.river.full };

/** An event counts only while younger than its reporter's age limit (measured from `now`)
 *  and not more than FUTURE_TOLERANCE_MIN in the future — re-checked at use, since carried-forward
 *  or cached event lists can outlive the age filter applied at parse time. */
export function isLiveEvent(e: FloodEvent, now: Date): boolean {
  const t = Date.parse(e.t);
  if (Number.isNaN(t) || isTooFarInFuture(new Date(t), now)) return false;
  return now.getTime() - t <= EVENT_AGE_H[e.reporter] * 3600e3;
}

/** Hourly forecast amounts still ahead of `now`, or null when the forecast run is stale. */
export function remainingForecastMm(f: ForecastPoint, now: Date): number[] | null {
  const elapsedMs = now.getTime() - Date.parse(f.start);
  if (Number.isNaN(elapsedMs) || elapsedMs > FORECAST.maxAgeH * 3600e3) return null;
  return f.mm.slice(Math.max(0, Math.floor(elapsedMs / 3600e3)));
}

function obsReason(o: Observation, km: number, level: Level, family: Family, kind: SignalKind, direct: boolean): Reason {
  const params: Record<string, number | string> = {};
  if ((o.kind === 'river' || o.kind === 'canal') && o.bank !== undefined) params.freeboardCm = Math.round((o.bank - o.v) * 100);
  if (o.slope3h !== undefined && o.kind !== 'road') params.slopeCmH = Math.round(o.slope3h * 100);
  if (o.kind === 'canal' && o.bmaCrit !== undefined && o.v >= o.bmaCrit) params.overBmaCrit = 1;
  if (o.kind === 'road') { params.depthCm = o.v; if (o.flags?.includes('step5cm') && o.v >= 20) params.atLeast = 1; }
  if (o.kind === 'rain') { params.mm24 = o.v; if (o.r1h !== undefined) params.r1h = o.r1h; if (o.r3h !== undefined) params.r3h = o.r3h; }
  return {
    level, family, kind, direct, km: r2(km), at: o.held?.lastFreshAt ?? o.t, lat: o.lat, lon: o.lon,
    stationId: o.id, name: o.name, held: !!o.held, params,
  };
}

function evReason(evs: FloodEvent[], km: number, level: Level, kind: 'longdo' | 'traffy', direct: boolean): Reason {
  const latest = evs.reduce((a, b) => (Date.parse(b.t) > Date.parse(a.t) ? b : a));
  const depth = Math.max(0, ...evs.map((e) => e.depthCm ?? 0));
  const params: Record<string, number | string> = { count: evs.length };
  if (depth > 0) params.depthCm = depth;
  if (evs.some((e) => e.passable === false)) params.impassable = 1;
  return {
    level, family: 'report', kind, direct, km: r2(km), at: latest.t, lat: latest.lat, lon: latest.lon,
    eventIds: evs.map((e) => e.id), reporter: latest.reporter, name: latest.title, params,
  };
}

function reportSignals(lat: number, lon: number, events: readonly FloodEvent[], now: Date): Reason[] {
  const out: Reason[] = [];
  const live = events.filter((e) => isLiveEvent(e, now));
  const near = (r: Reporter, maxKm: number) => nearest(live.filter((e) => e.reporter === r), lat, lon, maxKm);

  for (const { item: e, km } of near('highway', DIST.longdoHighway)) {
    out.push(evReason([e], km, e.passable === false ? 3 : 2, 'longdo', false));
  }
  for (const { item: e, km } of near('itic', DIST.longdoFar)) {
    const inner = km <= DIST.longdoNear;
    const urgent = e.passable === false && ageMin(e.t, now) < ITIC_URGENT_H * 60;
    const level = (urgent ? 4 : 3) - (inner ? 0 : 1);
    out.push(evReason([e], km, clamp(level), 'longdo', inner));
  }
  const pub = near('public', DIST.longdoFar);
  for (const ring of [pub.filter((x) => x.km <= DIST.longdoNear), pub.filter((x) => x.km > DIST.longdoNear)]) {
    if (!ring.length) continue;
    const senders = new Set(ring.map((x) => x.item.by || 'unknown')).size;
    const inner = ring[0]!.km <= DIST.longdoNear;
    out.push(evReason(ring.map((x) => x.item), ring[0]!.km, clamp((senders >= 2 ? 3 : 2) - (inner ? 0 : 1)), 'longdo', false));
  }
  const tr = near('traffy', DIST.traffy);
  if (tr.length) {
    const deep = tr.filter((x) => (x.item.depthCm ?? 0) >= TRAFFY.deepCm).length >= TRAFFY.deepTickets;
    const level: Level = deep ? 3 : tr.length >= TRAFFY.minTickets ? 2 : 1;
    out.push(evReason(tr.map((x) => x.item), tr[0]!.km, level, 'traffy', false));
  }
  return out;
}

export function assessPoint(lat: number, lon: number, input: RiskInput): Assessment {
  const live = input.obs.filter((o) => o.level > 0);
  const of = (k: Kind) => live.filter((o) => o.kind === k);
  const signals: Reason[] = [];

  // Step 1 — distance-adjusted signals
  for (const { item: o, km } of nearest(of('road'), lat, lon, DIST.road.far)) {
    const direct = km <= DIST.road.full;
    signals.push(obsReason(o, km, direct ? o.level : clamp(o.level - 1), 'water', 'road', direct));
  }
  for (const { item: o, km } of nearest(of('canal'), lat, lon, DIST.canal.far, DIST.canal.n)) {
    const direct = km <= DIST.canal.full;
    signals.push(obsReason(o, km, direct ? o.level : clamp(o.level - 1), 'water', 'canal', direct));
  }
  for (const { item: o, km } of nearest(of('river'), lat, lon, DIST.river.far, DIST.river.n)) {
    let level: number = o.level;
    let direct = km <= DIST.river.full;
    let far = false;
    if (km > DIST.river.down1) { level = Math.min(o.level - 2, 2); far = true; }
    else if (km > DIST.river.full) level = o.level - 1;
    if (BKK_METRO.includes(o.prov) && km > DIST.river.metroDirectKm) { direct = false; level = Math.min(level, 3); }
    const r = obsReason(o, km, clamp(level), 'water', 'river', direct);
    if (far) r.far = true;
    signals.push(r);
  }
  const rains = nearest(of('rain'), lat, lon, DIST.rain.far, DIST.rain.n);
  if (rains.length) {
    const top = rains.reduce((a, b) => (b.item.level > a.item.level ? b : a));
    signals.push(obsReason(top.item, top.km, top.item.level, 'rain', 'rain', false));
  }
  const rainStations2 = rains.filter((x) => x.item.level >= 2).length;
  const fc = nearest(input.forecast, lat, lon, DIST.forecast.far, 1)[0];
  const mm = fc ? remainingForecastMm(fc.item, input.now) : null;
  if (fc && mm) {
    const s3 = mm.slice(0, 3).reduce((a, b) => a + b, 0);
    const s6 = mm.slice(0, 6).reduce((a, b) => a + b, 0);
    if (s3 >= FORECAST.mm3h || s6 >= FORECAST.mm6h) {
      signals.push({ level: 2, family: 'forecast', kind: 'forecast', direct: false, km: r2(fc.km), at: fc.item.start,
        lat: fc.item.lat, lon: fc.item.lon, params: { mm3: Math.round(s3), mm6: Math.round(s6) } });
    }
  }
  signals.push(...reportSignals(lat, lon, input.events, input.now));

  // Step 2 — max
  const base = signals.length ? Math.max(...signals.map((s) => s.level)) : 0;
  let L = base;
  const raisedBy: Assessment['raisedBy'] = [];

  // Step 3 — corroboration (each raise capped at 3)
  const water2 = signals.filter((s) => isWater(s.kind) && !s.far && s.level >= 2);
  if (hasIndependentPair(water2.map((s) => ({ id: s.stationId ?? '', kind: s.kind, lat: s.lat, lon: s.lon })), CORROB.independentKm)) {
    L = Math.max(L, 3);
    raisedBy.push('independent');
  }
  const fams = new Set(signals
    .filter((s) => s.level >= 2 && s.km <= CORROB.familyKm && !s.far && s.family !== 'forecast')
    .map((s) => s.family));
  if (fams.size >= 2) {
    L = Math.max(L, Math.min(3, L + 1));
    raisedBy.push('families');
  }
  const heavyRain = signals.some((s) => s.family === 'rain' && s.level >= 2);
  const stressedCanal = nearest(of('canal'), lat, lon, CORROB.drainageCanalKm).some(({ item: o }) =>
    (o.bank !== undefined && Math.round((o.bank - o.v) * 1000) / 1000 < CORROB.drainageFb)
    || (o.bmaCrit !== undefined && o.v >= o.bmaCrit)
    || !!o.flags?.includes('backflow'));
  if (heavyRain && stressedCanal) {
    L = Math.max(L, 3);
    raisedBy.push('drainage');
  }

  // Step 4 — caps
  if (L === 4 && !signals.some((s) => s.level === 4 && s.direct)) L = 3;
  const present = new Set(signals.filter((s) => s.level >= 2).map((s) => s.family));
  // Drainage (step 3c) corroborates via the canal's raw (non-distance-adjusted) state, which can be
  // real evidence even when the canal's distance-discounted step-1 signal level is below 2 — so a
  // successful drainage raise always counts 'water' as present for the rain-only cap below.
  if (raisedBy.includes('drainage')) present.add('water');
  const rainish = present.size > 0 && [...present].every((f) => f === 'rain' || f === 'forecast');
  if (rainish && L === 3 && rainStations2 < 2) L = 2;

  // Step 5 — no data
  const waterKms = live
    .filter((o) => o.kind === 'road' || o.kind === 'canal' || o.kind === 'river')
    .map((o) => ({ o, km: distKm(lat, lon, o.lat, o.lon) }));
  const hasWaterFull = waterKms.some(({ o, km }) => km <= (FULL_KM[o.kind] ?? 0));
  const rainOutsideMetro = [...of('rain'), ...input.rain0]
    .some((r) => !BKK_METRO.includes(r.prov) && distKm(lat, lon, r.lat, r.lon) <= DIST.rain.far);
  if (hasWaterFull || rainOutsideMetro) L = Math.max(L, 1);
  else if (L <= 1) L = 0;
  const incomplete = !!input.incomplete;
  if (incomplete && L <= 1) L = 0;

  // Step 6 — confidence
  const determining = signals.filter((s) => base > 0 && s.level === base);
  const highDirect = determining.some((s) => s.direct && (
    (s.kind === 'road' && s.km <= CONF.highRoadKm)
    || (s.kind === 'canal' && s.km <= CONF.highCanalKm)
    || (s.kind === 'river' && s.km <= CONF.highRiverKm)));
  let conf = 0;
  if (L > 0 && (highDirect || raisedBy.includes('independent') || raisedBy.includes('families'))) conf = 2;
  else if (L > 0 && (determining.some((s) => s.direct)
    || determining.some((s) => isWater(s.kind) && !s.far && s.km <= CONF.mediumWaterKm)
    || determining.some((s) => s.reporter === 'itic'))) conf = 1;
  if (determining.some((s) => s.held)) conf = Math.max(0, conf - 1);
  const confidence = (['low', 'medium', 'high'] as const)[conf]!;

  // Step 7 — basis and headline
  const reportObserved = (s: Reason) => s.family === 'report'
    && ((s.kind === 'longdo' && s.km <= DIST.longdoNear) || (s.kind === 'traffy' && s.km <= DIST.traffy));
  const basis: Assessment['basis'] = L === 0
    ? 'inferred'
    : determining.some((s) => (isWater(s.kind) && s.direct) || reportObserved(s))
      ? 'observed'
      : determining.length && determining.every((s) => s.family === 'forecast') ? 'forecast' : 'inferred';
  let headline: Headline = 'none';
  if (L >= 2) {
    if (determining.some((s) => s.kind === 'road' || s.family === 'report')) headline = 'road';
    else if (determining.some((s) => s.kind === 'canal' || s.kind === 'river')) headline = 'waterway';
    else if (determining.some((s) => s.family === 'rain')) headline = 'rain';
    else if (determining.some((s) => s.family === 'forecast')) headline = 'forecast';
  }

  const roadDepths = nearest(of('road'), lat, lon, DIST.road.far).map((x) => x.item.v).filter((v) => v > 0);
  const nearestWaterKm = waterKms.length ? r2(Math.min(...waterKms.map((x) => x.km))) : null;
  const reasons = [...signals].sort((a, b) => b.level - a.level || a.km - b.km).slice(0, 5);
  const dataAt = determining.length ? determining.map((s) => s.at).sort().at(-1)! : null;

  return {
    level: L as Level, confidence, basis, headline,
    vehicleDepthCm: roadDepths.length ? Math.max(...roadDepths) : undefined,
    reasons,
    coverage: {
      water: hasWaterFull ? 'near' : nearestWaterKm !== null && nearestWaterKm <= DIST.river.far ? 'far' : 'none',
      nearestWaterKm,
    },
    raisedBy, incomplete, dataAt,
  };
}
