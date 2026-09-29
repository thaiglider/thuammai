import { ALERT } from './alert-config';

const SCALE = 10 ** ALERT.keyDecimals;

/** A coordinate rounded to ALERT.keyDecimals places; never -0. */
export function roundAlert(n: number): number {
  return Math.round(n * SCALE) / SCALE + 0;
}

/** The place key used by D1, the alerts job and the SW name cache, e.g. "13.812,100.512".
 *  Deliberately coarser than the web's placeKey (4 decimals). */
export function alertKey(lat: number, lon: number): string {
  return `${roundAlert(lat).toFixed(ALERT.keyDecimals)},${roundAlert(lon).toFixed(ALERT.keyDecimals)}`;
}

export const ALERT_KEY_RE = /^-?\d{1,3}\.\d{3},-?\d{1,3}\.\d{3}$/;

/** The coordinates of a canonical key; null for anything alertKey() would not produce. */
export function parseAlertKey(key: string): { lat: number; lon: number } | null {
  if (!ALERT_KEY_RE.test(key)) return null;
  const [a, b] = key.split(',');
  const lat = Number(a);
  const lon = Number(b);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || alertKey(lat, lon) !== key) return null;
  return { lat, lon };
}
