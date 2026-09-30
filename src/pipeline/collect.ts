import { HOSPITAL, MIN_COUNT, TRAFFY } from '../core/thresholds';
import { ageMin, toIso07 } from '../core/time';
import type { FloodEvent, ForecastPoint, Hospital, RawObs, SourceHealth, SourceId, TmdWarning } from '../core/types';
import type { Fetcher } from './fetcher';
import { THAIWATER_HEADERS } from './http';
import { LONGDO_URL, parseLongdo } from './sources/longdo';
import { forecastPoints, openMeteoUrl, parseOpenMeteo } from './sources/openmeteo';
import { TW_URL, parseCanal, parseDam, parseRain, parseRiver, parseRoad } from './sources/thaiwater';
import { TMD_URL, parseTmd } from './sources/tmd';
import { OVERPASS_URL, overpassBody, parseOverpassHospitals } from './sources/osm-hospitals';
import { fetchTraffy } from './sources/traffy';
import type { PipelineState } from './state';
import type { StaticData } from './static-data';

export interface Collected {
  river: RawObs[]; rain: RawObs[]; road: RawObs[]; canal: RawObs[]; dam: RawObs[];
  longdo: FloodEvent[]; traffy: FloodEvent[]; forecast: ForecastPoint[]; tmd: TmdWarning[];
  /** OSM hospitals (weekly refresh, carried between runs) and the ISO time of the last good fetch. */
  hospitals: Hospital[]; hospitalsFetchedAt: string | null;
  health: SourceHealth[]; traffyWindowH: number;
}

/** A forecast fetched less than this long ago is reused instead of calling Open-Meteo again. */
const FORECAST_REUSE_MIN = 60;
const HEALTH_ORDER: SourceId[] = ['river', 'rain', 'road', 'canal', 'dam', 'longdo', 'traffy', 'forecast', 'tmd', 'hospitals'];

type Timed = { t?: string; start?: string };
type Result<T> = { items: T[]; health: SourceHealth };

async function run<T extends Timed>(id: SourceId, st: PipelineState, now: Date, fn: () => Promise<T[]>): Promise<Result<T>> {
  let items: T[];
  const h: SourceHealth = { id, ok: true, count: 0, newest: null, lagMin: null };
  try {
    items = await fn();
    if (items.length < MIN_COUNT[id]) throw new Error(`suspiciously few items: ${items.length}`);
    st.lastGood[id] = { at: toIso07(now), data: items };
  } catch (e) {
    const lg = st.lastGood[id];
    items = lg ? (lg.data as T[]) : [];
    h.ok = false;
    h.error = e instanceof Error ? e.message : String(e);
    if (lg) h.carriedFrom = lg.at;
  }
  const times = items.map((x) => x.t ?? x.start).filter((t): t is string => !!t).sort();
  h.count = items.length;
  h.newest = times.at(-1) ?? null;
  h.lagMin = h.newest ? Math.round(ageMin(h.newest, now)) : null;
  return { items, health: h };
}

export async function collectAll(
  f: Fetcher, st: PipelineState, now: Date, sd: StaticData, sleep?: (ms: number) => Promise<void>,
): Promise<Collected> {
  const tw = (url: string) => f.json(url, THAIWATER_HEADERS);

  // (a) ThaiWater: one host, fetched sequentially to stay polite.
  const thaiwater = async () => {
    const river = await run('river', st, now, async () => parseRiver(await tw(TW_URL.river), now, sd.tidal));
    const rain = await run('rain', st, now, async () => parseRain(await tw(TW_URL.rain), now));
    const road = await run('road', st, now, async () => parseRoad(await tw(TW_URL.road), now));
    const canal = await run('canal', st, now, async () => parseCanal(await tw(TW_URL.canal), now));
    const dam = await run('dam', st, now, async () => parseDam(await tw(TW_URL.dam), now, sd));
    return { river, rain, road, canal, dam };
  };

  // (b) Longdo: a non-array or empty feed is an outage, not "no floods".
  const longdoP = run('longdo', st, now, async () => {
    const raw = await f.json(LONGDO_URL);
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('longdo returned no events');
    return parseLongdo(raw, now);
  });

  // (c) Traffy: window capped at 6 h; frozen at the last successful value while failing.
  const prevTraffy = (st.lastGood.traffy?.data as FloodEvent[] | undefined) ?? [];
  const traffyP = run('traffy', st, now, async () => {
    const r = await fetchTraffy(f, now, prevTraffy, st.traffyCoveredSince, sleep);
    st.traffyCoveredSince = r.coveredSince;
    const h = (now.getTime() - Date.parse(r.coveredSince)) / 3600e3;
    st.traffyWindowH = Math.min(TRAFFY.maxWindowH, Math.max(0, Math.round(h * 10) / 10));
    return r.events;
  });

  // (d) Open-Meteo: reuse a forecast fetched within the last hour.
  const pts = forecastPoints(sd.provinces, sd.districts);
  const lgForecast = st.lastGood.forecast;
  const reuse = !!lgForecast && ageMin(lgForecast.at, now) < FORECAST_REUSE_MIN && ageMin(lgForecast.at, now) >= 0;
  const forecastP = reuse
    ? Promise.resolve(reusedForecast(lgForecast!.data as ForecastPoint[], now))
    : run('forecast', st, now, async () => parseOpenMeteo(await f.json(openMeteoUrl(pts)), pts, now));

  // (e) TMD
  const tmdP = run('tmd', st, now, async () =>
    parseTmd(await f.text(TMD_URL)).map((w) => ({ ...w, t: w.issued ?? undefined })));

  const hospitalsP = collectHospitals(f, st, now, sd);

  const [tw5, longdo, traffy, forecast, tmdTimed, hospitals] = await Promise.all([thaiwater(), longdoP, traffyP, forecastP, tmdP, hospitalsP]);

  const traffyWindowH = st.traffyWindowH ?? 0;
  traffy.health.windowH = traffyWindowH;
  const byId: Record<SourceId, SourceHealth> = {
    river: tw5.river.health, rain: tw5.rain.health, road: tw5.road.health, canal: tw5.canal.health, dam: tw5.dam.health,
    longdo: longdo.health, traffy: traffy.health, forecast: forecast.health, tmd: tmdTimed.health, hospitals: hospitals.health,
  };
  const tmd: TmdWarning[] = tmdTimed.items.map(({ title, body, issued }) => ({ title, body, issued }));
  return {
    river: tw5.river.items, rain: tw5.rain.items, road: tw5.road.items, canal: tw5.canal.items, dam: tw5.dam.items,
    longdo: longdo.items, traffy: traffy.items, forecast: forecast.items, tmd,
    hospitals: hospitals.items, hospitalsFetchedAt: st.lastGood.hospitals?.at ?? null,
    health: HEALTH_ORDER.map((id) => byId[id]), traffyWindowH,
  };
}

function reusedForecast(items: ForecastPoint[], now: Date): Result<ForecastPoint> {
  const times = items.map((x) => x.start).sort();
  const newest = times.at(-1) ?? null;
  return {
    items,
    health: { id: 'forecast', ok: true, count: items.length, newest, lagMin: newest ? Math.round(ageMin(newest, now)) : null },
  };
}

/** One Overpass POST when due (never fetched, or a week since the last good fetch), and not within
 *  HOSPITAL.retryMin of a failed attempt; otherwise the last good list is carried unchanged. */
async function collectHospitals(f: Fetcher, st: PipelineState, now: Date, sd: StaticData): Promise<Result<Hospital>> {
  const lg = st.lastGood.hospitals;
  const dueAge = lg ? ageMin(lg.at, now) : Infinity;
  const due = !lg || dueAge >= HOSPITAL.refreshDays * 1440 || dueAge < 0;
  const failedAge = st.hospitalsAt ? ageMin(st.hospitalsAt, now) : Infinity;
  if (!due || (failedAge >= 0 && failedAge < HOSPITAL.retryMin)) {
    const items = (lg?.data as Hospital[] | undefined) ?? [];
    const health: SourceHealth = { id: 'hospitals', ok: due ? false : true, count: items.length, newest: null, lagMin: null };
    if (due) {
      health.error = 'ดึงล้มเหลวล่าสุด รอลองใหม่';
      if (lg) health.carriedFrom = lg.at;
    }
    return { items, health };
  }
  const r = await run<Hospital & Timed>('hospitals', st, now, async () => {
    if (!f.postJson) throw new Error('fetcher cannot POST');
    return parseOverpassHospitals(await f.postJson(OVERPASS_URL, overpassBody(), { timeoutMs: 90_000 }), sd);
  });
  if (r.health.ok) delete st.hospitalsAt; else st.hospitalsAt = toIso07(now);
  return r;
}
