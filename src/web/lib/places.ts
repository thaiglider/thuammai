import { inThailand } from '../../core/geo';

export interface Place { name: string; lat: number; lon: number }
export const MAX_NAME = 40;
export const MAX_PLACES = 10;
export const PRESET_NAMES = ['บ้าน', 'ที่ทำงาน', 'บ้านพ่อแม่', 'โรงเรียนลูก'] as const;

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

// A high surrogate not followed by a low surrogate, or a low surrogate not preceded by a high
// surrogate: half of a broken pair. Left in a name, it would make encodeURIComponent throw.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanName(s: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control chars from hostile share-link input
  const stripped = s.replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const safe = stripped.replace(LONE_SURROGATE, '');
  // Truncate by code point, not UTF-16 unit, so a MAX_NAME-th astral character (e.g. an emoji)
  // is never split in half.
  const t = [...safe].slice(0, MAX_NAME).join('');
  return t || 'จุดที่บันทึก';
}

export const placeKey = (p: Place) => `${r4(p.lat).toFixed(4)},${r4(p.lon).toFixed(4)}`;

/** Names are percent-encoded with "~" also escaped, so literal "~" and "|" are always separators. */
export function encodePlaces(places: Place[]): string {
  return places.slice(0, MAX_PLACES)
    .map((p) => `${encodeURIComponent(cleanName(p.name)).replace(/~/g, '%7E')}~${r4(p.lat)},${r4(p.lon)}`)
    .join('|');
}

function parseParts(parts: string[], decodeNames: boolean): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const i = part.lastIndexOf('~');
    if (i < 0) continue;
    let name = part.slice(0, i);
    if (decodeNames) { try { name = decodeURIComponent(name); } catch { /* keep as is */ } }
    const [a, b] = part.slice(i + 1).split(',');
    const lat = Number(a);
    const lon = Number(b);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inThailand(lat, lon)) continue;
    const p = { name: cleanName(name), lat: r4(lat), lon: r4(lon) };
    if (seen.has(placeKey(p))) continue;
    seen.add(placeKey(p));
    out.push(p);
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}

export function decodePlacesFromHash(hash: string): Place[] {
  const m = /(?:^#|&)p=([^&]*)/.exec(hash);
  if (!m) return [];
  const raw = m[1]!;

  // Parse two ways, since a hostile or foreign-tool value is ambiguous:
  // (A) our own format: literal "|" separators, per-name percent-encoding ("~" escaped to %7E).
  // (B) a value that was percent-encoded as a whole (separators arrive as %7C / %7E).
  // Whichever yields more valid places wins; a tie favours (A), our own format.
  const a = parseParts(raw.split('|'), true);
  let decodedOnce: string | null;
  try { decodedOnce = decodeURIComponent(raw); } catch { decodedOnce = null; }
  const b = decodedOnce === null ? [] : parseParts(decodedOnce.split('|'), false);

  return b.length > a.length ? b : a;
}

export function mergePlaces(existing: Place[], incoming: Place[]): Place[] {
  const keys = new Set(existing.map(placeKey));
  const out = [...existing];
  for (const p of incoming) {
    if (out.length >= MAX_PLACES) break;
    if (!keys.has(placeKey(p))) { out.push(p); keys.add(placeKey(p)); }
  }
  return out;
}

// A decimal number token that is not embedded in a longer run of digits/dots on either side,
// e.g. the "7.5" inside "13.7.5" must not match.
const NUM = '(?<![\\d.])(-?\\d{1,3}\\.\\d+)(?![\\d.])';
const PATTERNS = [
  new RegExp(`!3d${NUM}!4d${NUM}`, 'g'),
  new RegExp(`@${NUM},${NUM}`, 'g'),
  new RegExp(`[?&](?:q|query|ll|destination|center|daddr)=${NUM},\\s*${NUM}`, 'g'),
  new RegExp(`[?&]latitude=${NUM}[^\\s]*?[?&]longitude=${NUM}`, 'g'),
  new RegExp(`${NUM}\\s*[, ]\\s*${NUM}`, 'g'),
];

export function parseLocationInput(text: string): { lat: number; lon: number } | { error: 'short-link' } | null {
  const t = text.trim();
  if (/(maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(t)) return { error: 'short-link' };
  for (const re of PATTERNS) {
    for (const m of t.matchAll(re)) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (inThailand(a, b)) return { lat: r4(a), lon: r4(b) };
      if (inThailand(b, a)) return { lat: r4(b), lon: r4(a) };
    }
  }
  return null;
}

export function shareUrl(base: string, places: Place[]): string {
  const clean = base.replace(/[?#].*$/, '');
  return `${clean}?openExternalBrowser=1#p=${encodePlaces(places)}`;
}

/** How many of `incoming` would actually be added given the MAX_PLACES cap, and the banner text. */
export function importSummary(existing: Place[], incoming: Place[]): { added: number; text: string } {
  const added = mergePlaces(existing, incoming).length - existing.length;
  const fresh = incoming.filter((p) => !existing.some((q) => placeKey(q) === placeKey(p))).length;
  let text: string;
  if (added === 0) text = `มีครบ ${MAX_PLACES} จุดแล้ว — ลบบางจุดก่อนจึงจะเพิ่มจุดจากลิงก์นี้ได้`;
  else if (added < fresh) text = `ลิงก์นี้มี ${fresh} จุด — เพิ่มได้อีก ${added} จุด (สูงสุด ${MAX_PLACES})`;
  else text = `เพิ่ม ${added} จุดจากลิงก์นี้?`;
  return { added, text };
}

/** `?lat=…&lon=…` (from the /p/ area pages' "ดูความเสี่ยงที่บ้านของฉัน" link), validated and rounded. */
export function parseLatLonParams(search: string): { lat: number; lon: number } | null {
  const q = new URLSearchParams(search);
  const a = q.get('lat');
  const b = q.get('lon');
  if (a === null || b === null || a.trim() === '' || b.trim() === '') return null;
  const lat = Number(a);
  const lon = Number(b);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inThailand(lat, lon)) return null;
  return { lat: r4(lat), lon: r4(lon) };
}

/** The URL search string with lat/lon removed (keeps e.g. ?tab=). */
export function stripLatLon(search: string): string {
  const q = new URLSearchParams(search);
  q.delete('lat');
  q.delete('lon');
  const s = q.toString();
  return s ? `?${s}` : '';
}
