import { LEVEL_COLOR, LEVEL_TH } from '../../core/labels';
import { assessPoint } from '../../core/risk';
import { fmtTime } from '../../core/time';
import type { Level } from '../../core/types';
import { NO_OFFICIAL_ORDER } from '../../core/advice';
import { distKm, inThailand } from '../../core/geo';
import { alertsCfg, alertsMode, alertsOn, alertsPausedByBuild, browserPushGlobals, GPS_CONFIRM_ALERTS_TH, GPS_CONFIRM_TH } from '../lib/alerts-state';
import type { AreaRow, DataStore, Meta } from '../lib/data';
import { clear, h } from '../lib/dom';
import type { Env } from '../lib/env';
import { freshness, staleLine } from '../lib/freshness';
import { shareCaption } from '../lib/format';
import { coverageLine } from '../lib/coverage';
import { smooth, type HState } from '../lib/hysteresis';
import { cleanName, decodePlacesFromHash, encodePlaces, FULL_TH, importSummary, MAX_PLACES, mergePlaces, parseLatLonParams, parseLocationInput, placeKey, PRESET_NAMES, shareUrl, stripLatLon, type Place } from '../lib/places';
import { buildIndex, search, type GazIndex, type GazRow } from '../lib/search';
import type { Settings } from '../lib/settings';
import { getJson, setJson, type KV } from '../lib/storage';
import { renderCard } from './card';
import { openQr, sharePlaces } from './share';
import { refreshNavHashes, tabLink, type ShellRefs } from './shell';

export interface AppCtx {
  shell: ShellRefs; store: DataStore; kv: KV; env: Env; settings: Settings;
  meta: Meta; serverDate: string | null; now: () => Date; online: () => boolean; base: string;
}

// The gazetteer fetch is cached as a promise (not just its resolved value) so concurrent callers
// — e.g. several keystrokes typed before the first response lands — share one in-flight request
// instead of each starting its own. Reset to null on failure so a later attempt can retry.
let gazP: Promise<GazIndex | null> | null = null;
function gazetteer(ctx: AppCtx): Promise<GazIndex | null> {
  if (!gazP) {
    gazP = (async () => {
      try {
        const res = await fetch(`${ctx.base}static/gazetteer.json`);
        return buildIndex(((await res.json()) as { data: GazRow[] }).data);
      } catch {
        gazP = null;
        return null;
      }
    })();
  }
  return gazP;
}

export function loadPlaces(kv: KV): Place[] {
  const stored = getJson<Place[]>(kv, 'places', []);
  return Array.isArray(stored) ? stored.filter((p) => p && typeof p.lat === 'number' && typeof p.lon === 'number') : [];
}

export function currentPlaces(ctx: AppCtx): Place[] {
  return ctx.kv.persistent ? loadPlaces(ctx.kv) : decodePlacesFromHash(location.hash);
}

/** What the lazy alerts view needs from the page. */
function alertsCtx(ctx: AppCtx) {
  return { kv: ctx.kv, base: ctx.base, shell: ctx.shell, getPlaces: () => loadPlaces(ctx.kv) };
}

function savePlaces(ctx: AppCtx, places: Place[]): void {
  setJson(ctx.kv, 'places', places);
  const hash = places.length ? `#p=${encodePlaces(places)}` : '';
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  // Without persistent storage (e.g. LINE's in-app browser) the place list lives only in the
  // hash, so every nav link must carry it forward or switching tabs would lose it.
  refreshNavHashes(ctx.shell);
  // Alerts on: push the new set to the Worker (debounced; names only go to the SW cache).
  if (alertsOn(ctx.kv)) void import('./alerts').then((m) => m.onPlacesSaved(alertsCtx(ctx))).catch(() => undefined);
}

/** The naming prompt used by every way of adding a place (search, link, GPS, map pin). */
export function askPlaceName(kv: KV, fallback: string): string | null {
  const preset = PRESET_NAMES.find((n) => !loadPlaces(kv).some((p) => p.name === n)) ?? fallback;
  const name = prompt('ตั้งชื่อจุดนี้ (เช่น บ้าน, บ้านพ่อแม่)', preset);
  if (name === null) return null; // cancelled — add nothing
  return cleanName(name || fallback);
}

export function addPlace(ctx: AppCtx, p: Place): 'added' | 'dup' | 'full' {
  const places = currentPlaces(ctx);
  if (places.some((q) => placeKey(q) === placeKey(p))) return 'dup';
  if (places.length >= MAX_PLACES) return 'full';
  savePlaces(ctx, mergePlaces(places, [p]));
  return 'added';
}

function topAreas(areas: AreaRow[]): AreaRow[] {
  return areas.filter((a) => a.kind === 'province' && a.level >= 2).sort((a, b) => b.level - a.level || b.n2 / Math.max(1, b.N) - a.n2 / Math.max(1, a.N)).slice(0, 5);
}

/** The oldest of the snapshot time and any card's older-snapshot time: what "ณ HH:MM" may claim. */
function oldestAt(metaAt: string, olderAts: readonly (string | null)[]): string {
  return olderAts.reduce<string>((min, a) => (a && Date.parse(a) < Date.parse(min) ? a : min), metaAt);
}

function shareAllText(withShown: { p: Place; shownLevel: Level }[], generatedAt: string): string {
  const lines = withShown.map(({ p, shownLevel }) => `${p.name}: ${LEVEL_TH[shownLevel]}`);
  return `${lines.join('\n')}\n(ณ ${fmtTime(generatedAt)})`;
}

async function doShare(ctx: AppCtx, places: Place[], text: string): Promise<void> {
  const url = shareUrl(ctx.base, places);
  const r = await sharePlaces(ctx.env, url, text);
  if (r === 'copied') alert('คัดลอกแล้ว — วางในแชตได้เลย');
  if (r === 'failed') prompt('คัดลอกข้อความนี้', `${text}\n${url}`);
  // 'shared', 'line', 'cancelled' need no further action.
}

function announceRise(ctx: AppCtx): void {
  ctx.shell.banners.querySelector('[data-testid="rise-banner"]')?.remove();
  const banner = h('div', { class: 'banner', role: 'alert', 'data-testid': 'rise-banner' },
    h('span', {}, 'ระดับความเสี่ยงของจุดที่คุณติดตามสูงขึ้น — ดูรายละเอียดด้านล่าง'),
    h('button', { onclick: () => banner.remove() }, 'ปิด'));
  ctx.shell.banners.prepend(banner);
  if (!alertsOn(ctx.kv) && ctx.env.canNotify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification('ท่วมไหม', { body: 'ระดับความเสี่ยงของจุดที่คุณติดตามสูงขึ้น', icon: './icon-192.png' }); } catch { /* ignore */ }
  }
}

// Rebuilding the whole panel on every refresh (every 5 min, on visibility/online change, or
// after any place edit) would blow away whatever the user was mid-typing into the search box.
// So the add-panel is built once per page load and kept; only this "content" host (the import
// banner plus the cards/top-areas section) is re-rendered.
let panelState: { main: HTMLElement; content: HTMLElement } | null = null;
let liveCtx: AppCtx | null = null;
let contentGen = 0;

export async function renderHome(ctx: AppCtx): Promise<void> {
  liveCtx = ctx;
  const main = ctx.shell.main;
  if (!panelState || panelState.main !== main) {
    clear(main);
    const content = h('div', {});
    const addPanel = renderAddPanel(ctx, (p) => {
      const cur = liveCtx!;
      const result = addPlace(cur, p);
      if (result === 'added') void renderHome(cur);
      return result;
    });
    main.append(content, addPanel);
    panelState = { main, content };
  }
  await renderContent(ctx, panelState.content);
}

async function renderContent(ctx: AppCtx, content: HTMLElement): Promise<void> {
  const gen = ++contentGen;
  const places = currentPlaces(ctx);
  const now = ctx.now();
  const fr = freshness(ctx.meta.generatedAt, now, ctx.online());
  clear(content);

  // "ดูความเสี่ยงที่บ้านของฉัน" on an area page links here with ?lat=&lon= (the area's centre):
  // offer to add that point, named after the province it falls in.
  const point = parseLatLonParams(location.search);
  if (point) {
    const dropParams = () => history.replaceState(null, '', `${location.pathname}${stripLatLon(location.search)}${location.hash}`);
    if (places.some((q) => placeKey(q) === placeKey({ name: '', ...point }))) dropParams();
    else {
      const name = await provinceNameAt(ctx, point.lat, point.lon);
      if (gen !== contentGen) return;
      const full = places.length >= MAX_PLACES;
      const bar = h('div', { class: 'banner', 'data-testid': 'point-banner' },
        h('span', {}, full ? `มีครบ ${MAX_PLACES} จุดแล้ว — ลบบางจุดก่อนจึงจะเพิ่ม "${name}" ได้` : `เพิ่มจุด "${name}" เพื่อติดตามความเสี่ยง?`),
        full ? null : h('button', { class: 'primary', onclick: () => { dropParams(); savePlaces(ctx, mergePlaces(currentPlaces(ctx), [{ name, ...point }])); void renderHome(ctx); } }, 'เพิ่ม'),
        h('button', { onclick: () => { dropParams(); bar.remove(); } }, full ? 'ปิด' : 'ไม่'));
      content.append(bar);
    }
  }

  // Places arriving in a shared link
  const incoming = decodePlacesFromHash(location.hash).filter((p) => !places.some((q) => placeKey(q) === placeKey(p)));
  if (incoming.length && ctx.kv.persistent) {
    const sum = importSummary(places, incoming);
    const bar = h('div', { class: 'banner', 'data-testid': 'import-banner' },
      h('span', {}, sum.text),
      sum.added > 0 ? h('button', { class: 'primary', onclick: () => { savePlaces(ctx, mergePlaces(places, incoming)); void renderHome(ctx); } }, 'เพิ่ม') : null,
      h('button', { onclick: () => { bar.remove(); savePlaces(ctx, places); } }, sum.added > 0 ? 'ไม่' : 'ปิด'));
    content.append(bar);
  }

  if (!places.length) {
    const areas = await ctx.store.areas().catch(() => [] as AreaRow[]);
    if (gen !== contentGen) return;
    const tops = topAreas(areas);
    content.append(h('section', { 'data-testid': 'top-areas' },
      h('h2', {}, fr.grey ? 'จังหวัดที่น่าห่วง' : 'จังหวัดที่น่าห่วงตอนนี้'),
      fr.grey ? h('p', { class: 'muted', 'data-testid': 'top-areas-stale' }, staleLine(ctx.meta.generatedAt, now)) : null,
      tops.length
        ? h('div', {}, ...tops.map((a) => h('div', { class: 'row' },
            h('a', { href: `./p/${a.code}.html` }, a.name),
            h('span', { class: fr.grey ? 'badge grey' : 'badge', 'data-testid': 'top-area-level', style: `background:${LEVEL_COLOR[a.level].bg};color:${LEVEL_COLOR[a.level].fg};font-size:1rem` }, LEVEL_TH[a.level]))))
        : h('p', { class: 'muted' }, 'ยังไม่มีจังหวัดที่อยู่ในระดับเฝ้าระวังขึ้นไป'),
      h('p', {}, h('a', { href: './p/index.html' }, 'ดูทุกจังหวัดและทุกเขต'))));
    return;
  }

  const cards = h('section', { 'data-testid': 'cards' });
  content.append(cards);

  // Checked separately so a failed provinces file gets a visible message and a retry; the cards
  // themselves still render (as "ข้อมูลไม่ครบ", level 0) because inputFor tolerates the failure.
  const provincesOk = await ctx.store.provinces().then(() => true, () => false);
  if (gen !== contentGen) return;
  if (!provincesOk) cards.append(loadErrorBanner(() => void renderHome(liveCtx ?? ctx)));
  const assessed = await Promise.all(places.map(async (p) => {
    const input = await ctx.store.inputFor(p.lat, p.lon, now);
    const a = assessPoint(p.lat, p.lon, input);
    return { p, a, olderAt: input.olderSnapshotAt, coverage: coverageLine(a, p.lat, p.lon, input.obs) };
  }));
  if (gen !== contentGen) return;

  const hstates = getJson<Record<string, HState>>(ctx.kv, 'hyst', {});
  let rose = false;
  const withShown = assessed.map(({ p, a, olderAt, coverage }) => {
    const key = placeKey(p);
    const prev = hstates[key] ?? null;
    const next = smooth(prev, a.level, ctx.meta.generatedAt);
    // A place with no prior hysteresis state (prev === null) is a fresh add, not a "rise";
    // likewise a rise from an unassessed prior state (level 0) shouldn't alert.
    if (prev && prev.level > 0 && next.level > prev.level && next.level >= 2) rose = true;
    hstates[key] = next;
    const shownLevel: Level = ctx.kv.persistent ? next.level : a.level;
    return { p, a, shownLevel, olderAt, coverage };
  });
  setJson(ctx.kv, 'hyst', hstates);
  withShown.sort((x, y) => y.shownLevel - x.shownLevel);

  if (rose) announceRise(ctx);

  const compact = withShown.length > 3;
  for (const { p, a, shownLevel, olderAt, coverage } of withShown) {
    const key = placeKey(p);
    cards.append(renderCard({
      place: p, a, shownLevel, generatedAt: olderAt ?? ctx.meta.generatedAt, now, grey: fr.grey || olderAt !== null, compact, coverage,
      // A card built from an older snapshot shares that older time, never the newer meta time.
      onShare: () => void doShare(ctx, [p], shareCaption(p.name, shownLevel, olderAt ?? ctx.meta.generatedAt)),
      onRemove: () => { savePlaces(ctx, currentPlaces(ctx).filter((q) => placeKey(q) !== key)); void renderHome(ctx); },
      onRename: (name) => { savePlaces(ctx, currentPlaces(ctx).map((q) => (placeKey(q) === key ? { ...q, name: cleanName(name) } : q))); void renderHome(ctx); },
    }));
  }

  // Compact cards drop the per-card disclaimer, so the list carries it once.
  if (compact) cards.append(h('p', { class: 'muted', 'data-testid': 'list-disclaimer' }, NO_OFFICIAL_ORDER));
  const qrMsg = h('p', { class: 'muted', role: 'status', 'data-testid': 'qr-msg' });
  cards.append(h('div', { class: 'actions' },
    h('button', { 'data-testid': 'share-all', onclick: () => void doShare(ctx, places, shareAllText(withShown, oldestAt(ctx.meta.generatedAt, withShown.map((w) => w.olderAt)))) }, 'ส่งจุดทั้งหมดให้ครอบครัว'),
    h('button', { onclick: () => { qrMsg.textContent = ''; openQr(shareUrl(ctx.base, places)).catch(() => { qrMsg.textContent = 'เปิด QR ไม่ได้ขณะออฟไลน์ — ลองใหม่เมื่อต่อเน็ต'; }); } }, 'QR code')), qrMsg);

  // I3: "on" here but nothing can arrive (alerts switched off in this build, or no SW) → paused.
  const mode = alertsPausedByBuild(alertsCfg(), ctx.env, ctx.kv) ? 'paused' : alertsMode(alertsCfg(), ctx.env, ctx.kv, browserPushGlobals(), places.length);
  if (mode) {
    const host = h('section', { class: 'card', 'data-testid': 'alerts' });
    content.append(host);
    void import('./alerts')
      .then((m) => { if (gen === contentGen) m.mountAlerts(host, alertsCtx(ctx), mode); })
      .catch(() => host.remove());
  }
}

async function provinceNameAt(ctx: AppCtx, lat: number, lon: number): Promise<string> {
  const provs = await ctx.store.provinces().catch(() => null);
  if (!provs?.length) return 'จุดจากหน้าพื้นที่';
  const inside = provs.filter((p) => lon >= p.bbox[0] && lat >= p.bbox[1] && lon <= p.bbox[2] && lat <= p.bbox[3]);
  const pool = inside.length ? inside : provs;
  return pool.reduce((best, p) => (distKm(lat, lon, p.lat, p.lon) < distKm(lat, lon, best.lat, best.lon) ? p : best)).th;
}

/** Fetch what home needs (snapshot, areas, the data around each saved place) without touching the
 *  page; used to fill a newly active service worker's cache. Failures are ignored. */
export async function warmCache(store: DataStore, kv: KV, now: Date): Promise<void> {
  try {
    await store.meta();
    const places = kv.persistent ? loadPlaces(kv) : decodePlacesFromHash(location.hash);
    await Promise.allSettled([store.areas(), ...places.map((p) => store.inputFor(p.lat, p.lon, now))]);
  } catch { /* offline again, or a newer render will fetch it */ }
}

export function loadErrorBanner(retry: () => void): HTMLElement {
  return h('div', { class: 'banner', role: 'alert', 'data-testid': 'load-error' },
    h('span', {}, 'โหลดข้อมูลไม่ครบ — ระดับที่แสดงอาจไม่ครบถ้วน'),
    h('button', { class: 'primary', 'data-testid': 'load-retry', onclick: retry }, 'ลองใหม่'));
}

/** When no snapshot at all can be loaded (e.g. the very first visit is offline), still list the
 *  saved places — greyed, with no level — instead of an empty page. */
export function renderPlacesWithoutData(main: HTMLElement, kv: KV): void {
  const places = kv.persistent ? loadPlaces(kv) : decodePlacesFromHash(location.hash);
  if (!places.length) return;
  main.append(h('section', { 'data-testid': 'cards-nodata' },
    ...places.map((p) => h('article', { class: 'card', 'data-testid': 'card', 'aria-label': `${p.name}: ไม่มีข้อมูลในเครื่อง` },
      h('h2', {}, p.name),
      h('span', { class: 'badge grey', 'data-testid': 'card-level' }, 'ไม่มีข้อมูล'),
      h('p', { class: 'muted' }, 'ยังไม่มีข้อมูลเก็บไว้ในเครื่อง ไม่ได้แปลว่าปลอดภัย — ต่อเน็ตแล้วกด "ลองใหม่"')))));
}

function renderAddPanel(ctx: AppCtx, add: (p: Place) => 'added' | 'dup' | 'full'): HTMLElement {
  const input = h('input', { type: 'search', id: 'q', 'aria-label': 'ค้นหาตำบล เขต อำเภอ หรือวางลิงก์แผนที่', placeholder: 'ค้นหาตำบล เขต อำเภอ หรือวางลิงก์แผนที่', autocomplete: 'off', 'data-testid': 'search' });
  const results = h('ul', { class: 'list', 'data-testid': 'search-results' });
  const msg = h('p', { class: 'muted', role: 'status', 'data-testid': 'search-msg' });
  const choose = (name: string, lat: number, lon: number) => {
    if (!inThailand(lat, lon)) { msg.textContent = 'ตำแหน่งนี้อยู่นอกประเทศไทย'; return; }
    // Checked up front so a full list never bothers the user with the naming prompt first.
    if (currentPlaces(ctx).length >= MAX_PLACES) { msg.textContent = FULL_TH; return; }
    const finalName = askPlaceName(ctx.kv, name);
    if (finalName === null) return; // cancelled — don't add anything
    // Second check: guards a same-session race (e.g. another tab filled the list meanwhile).
    if (add({ name: finalName, lat, lon }) === 'full') msg.textContent = FULL_TH;
  };
  // Shared by the type-ahead and the Nominatim search so a slow, stale response from either
  // can never overwrite a faster, newer one.
  let seq = 0;
  input.addEventListener('focus', () => void gazetteer(ctx), { once: true });
  input.addEventListener('input', async () => {
    const my = ++seq;
    clear(results); msg.textContent = '';
    const q = input.value;
    const loc = parseLocationInput(q);
    if (loc && 'error' in loc) { msg.textContent = 'ลิงก์แบบย่อเปิดตรวจไม่ได้ — เปิดลิงก์ในแผนที่แล้วคัดลอกลิงก์เต็ม หรือพิมพ์ชื่อตำบลแทน'; return; }
    if (loc) { results.append(h('li', {}, h('button', { onclick: () => choose('ตำแหน่งจากลิงก์', loc.lat, loc.lon) }, `ใช้ตำแหน่งนี้ (${loc.lat}, ${loc.lon})`))); return; }
    const idx = await gazetteer(ctx);
    if (my !== seq) return;
    if (!idx) { msg.textContent = 'โหลดรายชื่อตำบลไม่สำเร็จ — วางลิงก์แผนที่ ใช้ตำแหน่งปัจจุบัน หรือค้นหาสถานที่'; return; }
    for (const hit of search(idx, q)) results.append(h('li', {}, h('button', { onclick: () => choose(hit.name, hit.lat, hit.lon) }, hit.label)));
    if (q.trim().length >= 2 && !results.children.length) msg.textContent = 'ไม่พบชื่อนี้ในรายชื่อตำบล ลองกด "ค้นหาสถานที่"';
  });
  let lastNominatim = 0;
  const nominatim = h('button', { 'data-testid': 'nominatim', onclick: async () => {
    const q = input.value.trim();
    if (q.length < 3 || Date.now() - lastNominatim < 1000) return;
    lastNominatim = Date.now();
    const my = ++seq;
    clear(results);
    msg.textContent = 'กำลังค้นหา…';
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=th&accept-language=th&limit=5&q=${encodeURIComponent(q)}`);
      const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
      if (my !== seq) return;
      clear(results);
      for (const r of rows) results.append(h('li', {}, h('button', { onclick: () => choose(r.display_name.split(',')[0]!, Number(r.lat), Number(r.lon)) }, r.display_name)));
      msg.textContent = rows.length ? 'ผลค้นหาจาก OpenStreetMap' : 'ไม่พบสถานที่';
    } catch {
      if (my !== seq) return;
      msg.textContent = 'ค้นหาสถานที่ไม่สำเร็จ';
    }
  } }, 'ค้นหาสถานที่ (OpenStreetMap)');
  const gps = ctx.env.canGeolocate ? h('button', { 'data-testid': 'gps', onclick: () => {
    if (!confirm(alertsOn(ctx.kv) ? GPS_CONFIRM_ALERTS_TH : GPS_CONFIRM_TH)) return;
    msg.textContent = 'กำลังหาตำแหน่ง…';
    navigator.geolocation.getCurrentPosition(
      (pos) => { msg.textContent = ''; choose('ตำแหน่งปัจจุบัน', Math.round(pos.coords.latitude * 1e4) / 1e4, Math.round(pos.coords.longitude * 1e4) / 1e4); },
      () => { msg.textContent = 'หาตำแหน่งไม่ได้ — ค้นหาชื่อตำบลหรือวางลิงก์แผนที่แทน'; input.focus(); },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  } }, 'ใช้ตำแหน่งปัจจุบัน') : null;
  // The old "only while this page is open" button stays only where Web Push is impossible (spec §6.1).
  const pushCapable = alertsMode(alertsCfg(), ctx.env, ctx.kv, browserPushGlobals(), 1) !== null;
  const notify = !pushCapable && ctx.env.canNotify && typeof Notification !== 'undefined' && Notification.permission === 'default'
    ? h('button', { onclick: async () => { await Notification.requestPermission(); } }, 'เตือนด้วยการแจ้งเตือนของเครื่อง (เฉพาะตอนเปิดหน้านี้ไว้)')
    : null;
  return h('section', { class: 'card' },
    h('h2', {}, 'เพิ่มจุดที่ต้องการติดตาม'),
    input, results, msg,
    h('div', { class: 'actions' }, gps,
      tabLink('map', { class: 'btnlink', 'data-testid': 'pick-on-map' }, 'เลือกบนแผนที่'),
      nominatim, notify),
    h('p', { class: 'muted' }, 'ข้อมูลสถานที่: © ผู้ร่วมพัฒนา OpenStreetMap · รายชื่อตำบล: OCHA COD-AB'));
}
