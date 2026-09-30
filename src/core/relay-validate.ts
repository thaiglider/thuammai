import type { RelayCanal, RelayRoad } from './relay-types';

/** Per-item checks shared by the relay (drops bad items before sending) and flood-api (rejects them). */
const T07 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/;
const CODE = /^[A-Za-z0-9._()-]{1,40}$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const numOrNull = (x: unknown, lo: number, hi: number): boolean => x === null || num(x, lo, hi);
/** Exactly these keys: every required one present, nothing outside required + optional. */
const keysOk = (o: Record<string, unknown>, req: readonly string[], opt: readonly string[] = []): boolean =>
  req.every((k) => k in o) && Object.keys(o).every((k) => req.includes(k) || opt.includes(k));

export const validTime07 = (x: unknown): x is string => typeof x === 'string' && T07.test(x) && !Number.isNaN(Date.parse(x));

function baseOk(o: Record<string, unknown>): boolean {
  return typeof o.code === 'string' && CODE.test(o.code)
    && typeof o.name === 'string' && o.name.length >= 1 && o.name.length <= 120
    && num(o.lat, 5, 21) && num(o.lon, 97, 106) && validTime07(o.t);
}

export function validRoad(x: unknown): x is RelayRoad {
  if (!isObj(x) || !keysOk(x, ['code', 'name', 'lat', 'lon', 't', 'cm'], ['district']) || !baseOk(x)) return false;
  return num(x.cm, -100, 5000) && (x.district === undefined || (typeof x.district === 'string' && x.district.length <= 80));
}

export function validCanal(x: unknown): x is RelayCanal {
  if (!isObj(x) || !keysOk(x, ['code', 'name', 'lat', 'lon', 't', 'level', 'bankL', 'bankR', 'warn', 'crit']) || !baseOk(x)) return false;
  return num(x.level, -50, 100) && numOrNull(x.bankL, -50, 100) && numOrNull(x.bankR, -50, 100) && numOrNull(x.warn, -50, 100) && numOrNull(x.crit, -50, 100);
}
