import { alertKey } from '../../core/alert-key';
import type { Place } from './places';

/** The SW cannot read localStorage: place names for notifications live in this cache (spec §6.3). */
export const ALERT_PLACES_CACHE = 'alert-places-v1';
export const ALERT_PLACES_PATH = '__alert-places.json';

/** Every place name under its ~100 m key (two places may share a key). */
export function namesByKey(places: readonly Place[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of places) (out[alertKey(p.lat, p.lon)] ??= []).push(p.name);
  return out;
}

export async function writeAlertPlaces(c: CacheStorage | null, base: string, places: readonly Place[]): Promise<void> {
  if (!c) return;
  try {
    const cache = await c.open(ALERT_PLACES_CACHE);
    await cache.put(new URL(ALERT_PLACES_PATH, base).href, new Response(JSON.stringify({ v: 1, names: namesByKey(places) }), { headers: { 'content-type': 'application/json' } }));
  } catch { /* storage full or blocked: the SW falls back to "จุดที่คุณติดตาม" */ }
}

export async function clearAlertPlaces(c: CacheStorage | null): Promise<void> {
  if (!c) return;
  try { await c.delete(ALERT_PLACES_CACHE); } catch { /* ignore */ }
}
