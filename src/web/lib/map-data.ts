import { inThailand } from '../../core/geo';
import { LEVEL_COLOR, LEVEL_TH } from '../../core/labels';
import { isLiveEvent } from '../../core/risk';
import { fmtTime } from '../../core/time';
import type { FloodEvent, Kind, Level, Observation, ProvinceGeo, Reporter } from '../../core/types';
import { obsValueText } from './format';
import { relativeAge } from './freshness';
import { parseLatLonParams, placeKey, type Place } from './places';

export type ExtraLayer = Kind | 'reports';
export const EXTRA_LAYERS: readonly { id: ExtraLayer; label: string }[] = [
  { id: 'river', label: 'แม่น้ำ' },
  { id: 'canal', label: 'คลอง' },
  { id: 'road', label: 'น้ำบนถนน' },
  { id: 'rain', label: 'ฝน' },
  { id: 'dam', label: 'เขื่อน' },
  { id: 'reports', label: 'รายงานน้ำท่วม' },
];
/** Extra station layers load the obs file of every province in view; beyond this many we ask the
 *  user to zoom in instead of downloading most of the country (~200 KB gzip). */
export const MAX_VIEW_PROVINCES = 6;
export const REPORT_COLOR = '#1d4ed8';
export const PLACE_COLOR = '#111827';
export const TH_OVERVIEW: { center: [number, number]; zoom: number } = { center: [100.99, 13.0], zoom: 4.6 };

export interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { id: string; kind: string; level: number; c: string; r: number };
}
export interface FC { type: 'FeatureCollection'; features: PointFeature[] }

const RADIUS: Record<Level, number> = { 0: 4, 1: 5, 2: 7, 3: 8, 4: 9 };
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const point = (lon: number, lat: number, properties: PointFeature['properties']): PointFeature =>
  ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });

/** Stations as map points; sorted low → high so the most serious are drawn on top. */
export function obsFeatures(obs: readonly Observation[], grey: boolean): FC {
  const features = [...obs].sort((a, b) => a.level - b.level).map((o) =>
    point(o.lon, o.lat, { id: o.id, kind: o.kind, level: o.level, c: LEVEL_COLOR[grey ? 0 : o.level].bg, r: RADIUS[o.level] }));
  return { type: 'FeatureCollection', features };
}

export function eventFeatures(events: readonly FloodEvent[], now: Date, grey: boolean): FC {
  const features = events.filter((e) => isLiveEvent(e, now)).map((e) =>
    point(e.lon, e.lat, { id: e.id, kind: 'report', level: 0, c: grey ? LEVEL_COLOR[0].bg : REPORT_COLOR, r: 6 }));
  return { type: 'FeatureCollection', features };
}

export function placeFeatures(places: readonly Place[]): FC {
  return { type: 'FeatureCollection', features: places.map((p) => point(p.lon, p.lat, { id: placeKey(p), kind: 'place', level: 0, c: PLACE_COLOR, r: 7 })) };
}

/** Province codes whose bbox intersects the view [west, south, east, north]; null when more than `max`. */
export function provincesInView(bounds: [number, number, number, number], provinces: readonly ProvinceGeo[], max: number = MAX_VIEW_PROVINCES): string[] | null {
  const [w, s, e, n] = bounds;
  const hit = provinces.filter((p) => p.bbox[0] <= e && p.bbox[2] >= w && p.bbox[1] <= n && p.bbox[3] >= s).map((p) => p.code);
  return hit.length > max ? null : hit;
}

/** Where the map opens: ?lat=&lon=[&z=] (from a card), else the first saved place, else Thailand. */
export function initialView(search: string, places: readonly Place[]): { center: [number, number]; zoom: number } {
  const p = parseLatLonParams(search);
  const z = Number(new URLSearchParams(search).get('z'));
  if (p) return { center: [p.lon, p.lat], zoom: Number.isFinite(z) && z >= 5 && z <= 17 ? z : 14 };
  if (places[0]) return { center: [places[0].lon, places[0].lat], zoom: 12 };
  return { center: [...TH_OVERVIEW.center], zoom: TH_OVERVIEW.zoom };
}

export function pinFromCenter(lat: number, lon: number): { lat: number; lon: number } | null {
  const p = { lat: r4(lat), lon: r4(lon) };
  return inThailand(p.lat, p.lon) ? p : null;
}

/** "+ ปักหมุดที่นี่" needs at least this zoom (~ a district on screen): zoomed further out, the map
 *  centre can be tens of km from where the user means, and the card would silently assess that. */
export const MIN_PIN_ZOOM = 12;

/** Whether the map centre may become a place: 'zoom' = zoom in first, 'outside' = not in Thailand. */
export function pinCheck(zoom: number, lat: number, lon: number): { lat: number; lon: number } | 'zoom' | 'outside' {
  // Rounded so a fractional zoom that is 12 on screen (e.g. 11.9999 after a pinch) still counts.
  if (!(Math.round(zoom * 100) / 100 >= MIN_PIN_ZOOM)) return 'zoom';
  return pinFromCenter(lat, lon) ?? 'outside';
}

/** MapLibre 'error' events: a tile or source (sourceId/tile) or a sprite/glyph request (an AJAX
 *  error for some other URL) is a partial failure, 'tiles'; the style itself (its URL, or a
 *  worker/other failure before the first load) is 'style', which replaces the map. */
export function mapErrorStage(ev: { sourceId?: unknown; tile?: unknown; error?: unknown }, loaded: boolean, styleUrl: string): 'style' | 'tiles' {
  if (ev.sourceId || ev.tile) return 'tiles';
  const url = typeof ev.error === 'object' && ev.error !== null ? (ev.error as { url?: unknown }).url : undefined;
  if (typeof url === 'string') return url.split('?')[0] === styleUrl ? 'style' : 'tiles';
  return loaded ? 'tiles' : 'style';
}

/** Attribution entries. MapLibre renders these as markup, so they are constants — never data.
 *  `key` = the word that shows the basemap style already credits it (null: always added). */
export const MAP_CREDIT: readonly { key: string | null; html: string }[] = [
  { key: 'OpenFreeMap', html: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>' },
  { key: 'OpenMapTiles', html: '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a>' },
  { key: null, html: 'ข้อมูลแผนที่ <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© ผู้ร่วมพัฒนา OpenStreetMap</a>' },
];

/** Our credits minus what the style's own source attribution already says (no double credit). */
export function creditsToAdd(styleAttribution: string): string[] {
  return MAP_CREDIT.filter((c) => c.key === null || !styleAttribution.includes(c.key)).map((c) => c.html);
}

/** Identity of what the extra layers show; unchanged → no refetch/setData on a pan. */
export function extrasKey(snapshot: string, grey: boolean, codes: readonly string[] | null, kinds: readonly string[]): string {
  return [snapshot, grey ? 'g' : '', codes ? [...codes].sort().join(',') : 'zoom', [...kinds].sort().join(',')].join('|');
}

/** Spec §6: save-data (the setting or the browser's Save-Data) never auto-loads the map. */
export function shouldAutoLoadMap(settingSaveData: boolean, envSaveData: boolean, online: boolean): boolean {
  return online && !settingSaveData && !envSaveData;
}

export function mapHref(p: Place, hash: string): string {
  return `./?tab=map&lat=${p.lat}&lon=${p.lon}&z=15${hash}`;
}

export interface StationRow { id: string; name: string; provTh: string; level: Level; value: string | null; t: string; held: boolean }

export function stationRows(obs: readonly Observation[], provinces: readonly ProvinceGeo[]): StationRow[] {
  const th = new Map(provinces.map((p) => [p.code, p.th]));
  return obs
    .map((o) => ({ id: o.id, name: o.name, provTh: th.get(o.prov) ?? '', level: o.level, value: obsValueText(o), t: o.held?.lastFreshAt ?? o.t, held: !!o.held }))
    .sort((a, b) => b.level - a.level || a.provTh.localeCompare(b.provTh, 'th') || a.name.localeCompare(b.name, 'th'));
}

const REPORTER_TH: Record<Reporter, string> = {
  highway: 'กรมทางหลวง (ทางการ) ผ่าน Longdo',
  itic: 'เจ้าหน้าที่ iTIC ผ่าน Longdo',
  public: 'ประชาชนแจ้งผ่าน Longdo (ยังไม่ยืนยัน)',
  traffy: 'ประชาชนแจ้งผ่าน Traffy (ยังไม่ยืนยัน)',
};
const present = (xs: (string | null)[]): string[] => xs.filter((x): x is string => !!x);

/** OpenFreeMap liberty labels places with `name_en` first ("The Owl Market"); we prefer Thai. */
export const TH_TEXT_FIELD = ['coalesce', ['get', 'name:th'], ['get', 'name'], ['get', 'name_en']] as const;
// A name reference in a token string ("{name_en}") or an expression ("name:latin" inside ["get", …]).
const NAME_REF = /(^|[{"])name(?:[_:][a-z]+)?(?=[}"]|$)/m;

/** The Thai-first text-field for a symbol layer that shows a name; null to leave the layer alone. */
export function thaiTextField(current: unknown): unknown[] | null {
  if (current === undefined || current === null || current === '') return null;
  const text = typeof current === 'string' ? current : JSON.stringify(current);
  return NAME_REF.test(text) ? (JSON.parse(JSON.stringify(TH_TEXT_FIELD)) as unknown[]) : null;
}

/** Lines under the station name in a popup: level word, value, time, source. */
export function stationPopupLines(o: Observation, now: Date, grey: boolean): string[] {
  const when = o.held ? `ค้างจาก ${fmtTime(o.held.lastFreshAt)}` : `วัดเมื่อ ${relativeAge(o.t, now)} (${fmtTime(o.t)})`;
  const level = grey ? `${LEVEL_TH[o.level]} (ข้อมูลเก่า อาจไม่ตรงกับตอนนี้)` : LEVEL_TH[o.level];
  return present([level, obsValueText(o), when, 'สสน. (ThaiWater)']);
}

/** Title first, then passability/depth, time and who reported it. */
export function reportPopupLines(e: FloodEvent, now: Date, grey = false): string[] {
  const when = `แจ้งเมื่อ ${relativeAge(e.t, now)} (${fmtTime(e.t)})`;
  return present([
    e.title,
    e.passable === false ? 'ผ่านไม่ได้' : null,
    typeof e.depthCm === 'number' ? `ลึกราว ${e.depthCm} ซม.` : null,
    grey ? `${when} (ข้อมูลเก่า อาจไม่ตรงกับตอนนี้)` : when,
    REPORTER_TH[e.reporter],
  ]);
}
