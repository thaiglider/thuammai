import { CAPS } from '../../src/core/alert-config';
import { alertKey } from '../../src/core/alert-key';
import { inThailand } from '../../src/core/geo';
import { isAllowedPushEndpoint } from '../../src/core/push-endpoint';
import { HttpError } from './http';

export const bad = (code: string): HttpError => new HttpError(400, code);
export const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Every required key present and nothing else (spec §4 "ไม่มี key แปลก"). */
export function exactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
}

const B64URL = /^[A-Za-z0-9_-]+$/;
/** Unpadded base64url → bytes; null for anything else. */
export function b64urlBytes(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 200 || !B64URL.test(s) || s.length % 4 === 1) return null;
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface PlaceIn { key: string; lat: number; lon: number }

/** 1–10 points in Thailand; the server rounds to 3 decimals itself and merges duplicates. */
export function parsePlaces(x: unknown): PlaceIn[] {
  if (!Array.isArray(x) || x.length === 0 || x.length > CAPS.placesPerTarget) throw bad('bad_places');
  const out = new Map<string, PlaceIn>();
  for (const p of x) {
    if (!isObj(p) || !exactKeys(p, ['lat', 'lon']) || typeof p.lat !== 'number' || typeof p.lon !== 'number' || !inThailand(p.lat, p.lon)) throw bad('bad_places');
    const key = alertKey(p.lat, p.lon);
    const [lat, lon] = key.split(',').map(Number) as [number, number];
    out.set(key, { key, lat, lon });
  }
  return [...out.values()];
}

function authOk(s: unknown): s is string {
  const b = b64urlBytes(s);
  return b !== null && b.length === 16;
}

export function parseSubscribe(x: unknown): { endpoint: string; p256dh: string; auth: string; places: PlaceIn[] } {
  if (!isObj(x) || !exactKeys(x, ['endpoint', 'keys', 'places'])) throw bad('bad_shape');
  if (!isAllowedPushEndpoint(x.endpoint)) throw bad('bad_endpoint');
  const keys = x.keys;
  if (!isObj(keys) || !exactKeys(keys, ['p256dh', 'auth'])) throw bad('bad_keys');
  const pk = b64urlBytes(keys.p256dh);
  if (!pk || pk.length !== 65 || pk[0] !== 4 || !authOk(keys.auth)) throw bad('bad_keys');
  return { endpoint: x.endpoint as string, p256dh: keys.p256dh as string, auth: keys.auth, places: parsePlaces(x.places) };
}

export function parseUnsubscribe(x: unknown): { endpoint: string; auth: string } {
  if (!isObj(x) || !exactKeys(x, ['endpoint', 'auth']) || typeof x.endpoint !== 'string' || x.endpoint.length > 1024 || !authOk(x.auth)) throw bad('bad_shape');
  return { endpoint: x.endpoint, auth: x.auth };
}
