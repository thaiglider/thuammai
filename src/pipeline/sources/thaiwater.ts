import { inThailand } from '../../core/geo';
import { CANAL, RAIN_OTHER, RIVER, ROAD } from '../../core/thresholds';
import { isTooFarInFuture, parseLocal, toIso07 } from '../../core/time';
import type { Flag, RawObs } from '../../core/types';
import { provinceAt, type StaticData } from '../static-data';

export const TW_BASE = 'https://api-v3.thaiwater.net/api/v1/thaiwater30';
export const TW_URL = {
  river: `${TW_BASE}/public/waterlevel_load`,
  rain: `${TW_BASE}/public/rain_24h`,
  road: `${TW_BASE}/public/flood_road`,
  canal: `${TW_BASE}/public/canal_waterlevel`,
  dam: `${TW_BASE}/analyst/dam`,
} as const;

const num = (x: unknown): number | undefined => {
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'string') {
    const s = x.trim();
    if (s === '') return undefined; // Number('  ') would be 0 — a blank is missing, not zero
    x = s;
  }
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Common checks: valid time (not far future) and coordinates in Thailand. Returns ISO time or null. */
function validTime(s: string | undefined, lat: number, lon: number, now: Date): string | null {
  const d = parseLocal(s);
  if (!d || isTooFarInFuture(d, now) || !inThailand(lat, lon)) return null;
  return toIso07(d);
}

export function parseRiver(raw: any, now: Date, tidal: Set<string>): RawObs[] {
  const out: RawObs[] = [];
  for (const x of raw?.waterlevel_data?.data ?? []) {
    const st = x.station ?? {};
    const v = num(x.waterlevel_msl);
    const lat = num(st.tele_station_lat) ?? NaN;
    const lon = num(st.tele_station_long) ?? NaN;
    const t = validTime(x.waterlevel_datetime, lat, lon, now);
    if (v === undefined || !t) continue;
    const bankRaw = num(st.min_bank);
    const bank = bankRaw && bankRaw !== 0 ? bankRaw : undefined;
    if (bank !== undefined && v > bank + RIVER.outOfRangeAboveBank) continue; // out_of_range: dropped
    const code = st.tele_station_oldcode || String(st.id);
    const flags: Flag[] = [];
    if (tidal.has(code)) flags.push('tidal');
    const sit = num(x.situation_level);
    out.push({
      id: `river:${code}`, kind: 'river', name: st.tele_station_name?.th ?? code,
      lat: r5(lat), lon: r5(lon), prov: String(x.geocode?.province_code ?? ''), amphoe: x.geocode?.amphoe_name?.th,
      t, v: r2(v), bank, sit: sit && sit >= 1 && sit <= 5 ? (sit as 1 | 2 | 3 | 4 | 5) : undefined,
      q: num(x.discharge), flags: flags.length ? flags : undefined,
    });
  }
  return out;
}

export function parseRain(raw: any, now: Date): RawObs[] {
  const out: RawObs[] = [];
  for (const x of raw?.data ?? []) {
    const st = x.station ?? {};
    const v = num(x.rain_24h);
    const lat = num(st.tele_station_lat) ?? NaN;
    const lon = num(st.tele_station_long) ?? NaN;
    const t = validTime(x.rainfall_datetime, lat, lon, now);
    if (v === undefined || v < 0 || v > RAIN_OTHER.max || !t) continue;
    const r1 = num(x.rain_1h);
    const code = st.tele_station_oldcode || String(st.id);
    out.push({
      id: `rain:${code}`, kind: 'rain', name: st.tele_station_name?.th ?? code,
      lat: r5(lat), lon: r5(lon), prov: String(x.geocode?.province_code ?? ''), amphoe: x.geocode?.amphoe_name?.th,
      t, v: r2(v), r1h: r1 !== undefined && r1 >= 0 ? r2(r1) : undefined,
    });
  }
  return out;
}

export function parseRoad(raw: any, now: Date): RawObs[] {
  const out: RawObs[] = [];
  for (const x of raw?.data ?? []) {
    const st = x.station ?? {};
    const v = num(x.floodroad_value);
    const lat = num(st.floodroad_lat) ?? NaN;
    const lon = num(st.floodroad_long) ?? NaN;
    const t = validTime(x.floodroad_datetime, lat, lon, now);
    if (v === undefined || v < 0 || v > ROAD.max || !t) continue;
    const name: string = st.floodroad_name?.th ?? '';
    const code = st.floodroad_oldcode || String(st.id);
    out.push({
      id: `road:${code}`, kind: 'road', name: name.replace(/\s*\*\s*$/, '').trim() || code,
      lat: r5(lat), lon: r5(lon), prov: String(x.geocode?.province_code ?? ''), amphoe: x.geocode?.amphoe_name?.th,
      t, v: r2(v), flags: name.includes('*') ? ['step5cm'] : undefined,
    });
  }
  return out;
}

export function parseCanal(raw: any, now: Date): RawObs[] {
  const out: RawObs[] = [];
  for (const x of raw?.data ?? []) {
    const st = x.station ?? {};
    const v = num(x.canal_value);
    const lat = num(st.canal_lat) ?? NaN;
    const lon = num(st.canal_long) ?? NaN;
    const t = validTime(x.canal_datetime, lat, lon, now);
    if (v === undefined || !t) continue;
    const flags: Flag[] = [];
    const bankRaw = num(st.bank);
    const bank = bankRaw !== undefined && bankRaw > CANAL.bankMin && bankRaw < CANAL.bankMax ? bankRaw : undefined;
    if (bank === undefined) flags.push('bank_invalid');
    const warn = num(st.warning_level);
    const crit = num(st.critical_level);
    const bmaCrit = warn !== undefined && crit !== undefined && warn > 0 && crit > warn ? crit : undefined;
    if (bmaCrit === undefined) flags.push('bma_thresh_invalid');
    const vOut = num(x.canal_out);
    if (vOut !== undefined && vOut > 0 && vOut >= v) flags.push('backflow');
    const code = st.canal_oldcode || String(st.id);
    out.push({
      id: `canal:${code}`, kind: 'canal', name: st.canal_name?.th ?? code,
      lat: r5(lat), lon: r5(lon), prov: String(x.geocode?.province_code ?? ''), amphoe: x.geocode?.amphoe_name?.th,
      t, v: r2(v), bank, bmaCrit, vOut: vOut !== undefined && vOut > 0 ? r2(vOut) : undefined,
      flags: flags.length ? flags : undefined,
    });
  }
  return out;
}

export function parseDam(raw: any, now: Date, sd: StaticData): RawObs[] {
  const out: RawObs[] = [];
  for (const x of raw?.data?.dam_daily ?? []) {
    const dam = x.dam ?? {};
    const v = num(x.dam_storage_percent);
    const lat = num(dam.dam_lat) ?? NaN;
    const lon = num(dam.dam_long) ?? NaN;
    const t = validTime(`${x.dam_date} 07:00`, lat, lon, now);
    if (v === undefined || !t) continue;
    out.push({
      id: `dam:${dam.dam_oldcode || dam.id}`, kind: 'dam', name: dam.dam_name?.th ?? String(dam.id),
      lat: r5(lat), lon: r5(lon), prov: provinceAt(lat, lon, sd) ?? '', t, v: r2(v),
    });
  }
  return out;
}
