import { inThailand, type LatLon } from './geo';

// A coordinate needs ≥3 decimal places (≈100 m, the precision a followed point keeps) — so
// "ซอย 5", "1.5 ชม." or a price never read as a place.
const NUM = /(?<![\d.])-?\d{1,3}\.\d{3,}(?![\d.])/g;
const PIN = /!3d(-?\d{1,3}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/;
const ADJACENT = /^\s*[,/]?\s*$/;
const MAX_LEN = 2000;

const valid = (lat: number, lon: number): boolean => Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** A place from typed text or a Google Maps link that carries its coordinates (Telegram Desktop
 *  and Web cannot send a location). Two numbers inside Thailand are read in either order (its
 *  latitude and longitude ranges do not overlap) with any words between them; elsewhere only a
 *  plain "lat, lon" pair counts. A place pin (`!3d…!4d…`) wins over a map centre (`@…`). */
export function parseCoords(text: string): LatLon | null {
  let s = text.slice(0, MAX_LEN);
  try { s = decodeURIComponent(s); } catch { /* keep the raw text */ }
  const pin = s.match(PIN);
  if (pin) {
    const lat = Number(pin[1]);
    const lon = Number(pin[2]);
    if (valid(lat, lon)) return { lat, lon };
  }
  const nums = [...s.matchAll(NUM)];
  for (let i = 0; i + 1 < nums.length; i++) {
    const a = Number(nums[i]![0]);
    const b = Number(nums[i + 1]![0]);
    if (inThailand(a, b)) return { lat: a, lon: b };
    if (inThailand(b, a)) return { lat: b, lon: a };
    const between = s.slice(nums[i]!.index + nums[i]![0].length, nums[i + 1]!.index);
    if (ADJACENT.test(between) && valid(a, b)) return { lat: a, lon: b };
  }
  return null;
}
