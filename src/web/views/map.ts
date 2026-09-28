import { LEVEL_COLOR, LEVEL_TH } from '../../core/labels';
import { fmtTime } from '../../core/time';
import type { FloodEvent, Level, Observation, ProvinceGeo } from '../../core/types';
import { snapshotMismatch } from '../lib/data';
import { clear, h } from '../lib/dom';
import { freshness, relativeAge, staleLine } from '../lib/freshness';
import {
  EXTRA_LAYERS, eventFeatures, extrasKey, initialView, obsFeatures, pinCheck, PLACE_COLOR, placeFeatures, provincesInView,
  REPORT_COLOR, reportPopupLines, shouldAutoLoadMap, stationPopupLines, stationRows, type ExtraLayer, type StationRow,
} from '../lib/map-data';
import { FULL_TH, MAX_PLACES, placeKey } from '../lib/places';
import type { MapCanvas, SourceId } from '../map/canvas';
import { addPlace, askPlaceName, currentPlaces, type AppCtx } from './home';
import { tabHref } from './shell';

/** Map JS + worker (~0.5 MB gzip, checked by tools/check-budget.mjs) plus style, glyphs and first tiles. */
export const MAP_DOWNLOAD_TEXT = '~1.5 MB';

type Problem = 'nogl' | 'offline' | 'style' | 'tiles';
const PROBLEM_TH: Record<Problem, string> = {
  nogl: 'เครื่องหรือเบราว์เซอร์นี้แสดงแผนที่ไม่ได้ — ดูรายชื่อสถานีที่น่าห่วงด้านล่างแทน',
  offline: 'ออฟไลน์ — แผนที่ต้องใช้อินเทอร์เน็ต ดูรายชื่อสถานีที่น่าห่วงด้านล่างแทน',
  style: 'โหลดแผนที่ไม่ได้ — ดูรายชื่อสถานีที่น่าห่วงด้านล่างแทน',
  tiles: 'โหลดแผนที่บางส่วนไม่ได้ — ตรวจสอบอินเทอร์เน็ต หรือดูรายชื่อสถานีด้านล่าง',
};
/** flagged.json could not be loaded: an empty map must not read as "nothing to worry about". */
export const FLAGGED_FAILED_TH = 'โหลดข้อมูลสถานีไม่ได้ — แผนที่นี้ยังไม่แสดงสถานีที่น่าห่วง แผนที่ว่างไม่ได้แปลว่าปลอดภัย';
export const PIN_ZOOM_TH = 'ซูมเข้าให้ใกล้จุดที่ต้องการก่อนปักหมุด';
const LAYERS_NEED_MAP_TH = 'เปิดแผนที่ก่อน จึงจะเลือกชั้นข้อมูลได้';

interface MapState {
  ctx: AppCtx; main: HTMLElement; mapBox: HTMLElement; canvasHost: HTMLElement; cover: HTMLElement; pin: HTMLButtonElement;
  status: HTMLElement; legendNote: HTMLElement; layerNote: HTMLElement; list: HTMLDetailsElement; layerInputs: HTMLInputElement[];
  canvas: MapCanvas | null; problem: Problem | null; grey: boolean; dataAt: string; flagged: Observation[];
  // 'flagged' stations (nationwide, always shown) and the extra kind layers' stations (province
  // obs files, shown only while toggled on) are kept in separate maps with separate staleness —
  // so a station that happens to be in both keeps its flagged reading/greyness for the flagged
  // dot, and the extra dot (possibly from an older province snapshot) states its own staleness.
  obsById: Map<string, Observation>; extraObsById: Map<string, Observation>; extraGrey: boolean;
  eventsById: Map<string, FloodEvent>; reportsGrey: boolean; on: Set<ExtraLayer>; extraSeq: number;
  // What the canvas's 'extra'/'reports' sources currently hold (see extrasKey); a pan inside the
  // same provinces then neither refetches nor re-sets the layer. Reset when the canvas changes.
  extraKey: string | null; reportsKey: string | null;
  // Chromium caches a failed dynamic import() for the page's lifetime, so retrying the same
  // import() call after one fails would just fail again — the retry button must reload instead.
  importFailed: boolean;
}

// Kept across the periodic refresh (every 5 min, visibility/online events) so the map is built
// once per page load and only its data is replaced.
let state: MapState | null = null;

export async function renderMapTab(ctx: AppCtx): Promise<void> {
  if (!state || state.main !== ctx.shell.main) state = mount(ctx);
  state.ctx = ctx;
  await refresh(state);
}

const swatch = (color: string) => h('span', { class: 'swatch', style: `background:${color}`, 'aria-hidden': 'true' });

function mount(ctx: AppCtx): MapState {
  const main = ctx.shell.main;
  clear(main);
  const canvasHost = h('div', { class: 'mapcanvas' });
  const cover = h('div', { class: 'mapcover', 'data-testid': 'map-cover' });
  const pin = h('button', { class: 'primary pin', 'data-testid': 'pin', hidden: true }, '+ ปักหมุดที่นี่');
  const mapBox = h('div', { class: 'mapbox', 'data-testid': 'map', 'data-state': 'idle' },
    canvasHost, h('div', { class: 'crosshair', 'aria-hidden': 'true' }), pin, cover);
  const status = h('p', { role: 'status', 'data-testid': 'map-status' });
  const legendNote = h('p', { class: 'muted', role: 'status', 'data-testid': 'map-legend-note' });
  const layerNote = h('p', { class: 'muted', role: 'status', 'data-testid': 'map-layer-note' });
  const list = h('details', { 'data-testid': 'map-list' });
  const levels: Level[] = [4, 3, 2, 1, 0];
  // Legend sits directly above the map so it is on screen whenever the map is.
  const legend = h('section', { 'aria-label': 'ความหมายของสีบนแผนที่' },
    h('ul', { class: 'legend', 'data-testid': 'map-legend' },
      ...levels.map((l) => h('li', {}, swatch(LEVEL_COLOR[l].bg), LEVEL_TH[l])),
      h('li', {}, swatch(REPORT_COLOR), 'รายงานน้ำท่วม'),
      h('li', {}, swatch(PLACE_COLOR), 'จุดของฉัน')),
    legendNote);
  const s: MapState = {
    ctx, main, mapBox, canvasHost, cover, pin, status, legendNote, layerNote, list, layerInputs: [],
    canvas: null, problem: null, grey: false, dataAt: ctx.meta.generatedAt, flagged: [], obsById: new Map(), extraObsById: new Map(), extraGrey: false,
    eventsById: new Map(), reportsGrey: false, on: new Set(), extraSeq: 0, extraKey: null, reportsKey: null,
    importFailed: false,
  };
  s.layerInputs = EXTRA_LAYERS.map((l) => h('input', {
    type: 'checkbox', 'data-testid': `layer-${l.id}`, onchange: (e: Event) => toggleLayer(s, l.id, (e.target as HTMLInputElement).checked),
  }));
  const layers = h('fieldset', { class: 'layers', 'data-testid': 'map-layers' },
    h('legend', {}, 'ชั้นข้อมูลเพิ่มเติม'),
    ...EXTRA_LAYERS.map((l, i) => h('label', { class: 'check' }, s.layerInputs[i]!, ` ${l.label}`)),
    layerNote);
  syncLayerInputs(s);
  pin.addEventListener('click', () => pinHere(s));
  main.append(
    h('h1', {}, 'แผนที่'),
    h('p', { class: 'muted' }, 'เลื่อนแผนที่ให้วงกลมกลางจออยู่ตรงจุดที่ต้องการ แล้วแตะ "+ ปักหมุดที่นี่" เพื่อเพิ่มจุดติดตาม · แตะจุดสีเพื่อดูรายละเอียดสถานี'),
    legend, mapBox, status, layers, list);
  return s;
}

async function refresh(s: MapState): Promise<void> {
  const { ctx } = s;
  const now = ctx.now();
  const fr = freshness(ctx.meta.generatedAt, now, ctx.online());
  const [flagged, provinces] = await Promise.all([
    ctx.store.flagged().catch(() => null),
    ctx.store.provinces().catch(() => [] as ProvinceGeo[]),
  ]);
  const olderAt = flagged ? snapshotMismatch(ctx.meta.generatedAt, [flagged.generatedAt]) : null;
  s.grey = fr.grey || olderAt !== null;
  s.dataAt = olderAt ?? ctx.meta.generatedAt;
  const notes = [
    flagged ? null : FLAGGED_FAILED_TH,
    s.grey ? `${staleLine(s.dataAt, now)} — จุดบนแผนที่จึงเป็นสีเทา` : null,
  ].filter(Boolean);
  s.legendNote.textContent = notes.join(' · ');
  if (!flagged) s.list.open = true;
  s.flagged = flagged?.obs ?? [];
  // Rebuilt fresh each refresh so a station that dropped out of the flagged list (no longer ≥2)
  // can never still answer a popup lookup with stale data.
  s.obsById.clear();
  for (const o of s.flagged) s.obsById.set(o.id, o);
  renderList(s, flagged ? stationRows(s.flagged, provinces) : null, now);
  gate(s);
  pushData(s);
  if (s.on.size) void loadExtras(s);
}

function setCover(s: MapState, ...children: (Node | null)[]): void {
  clear(s.cover);
  for (const c of children) if (c) s.cover.append(c);
}

/** Decide whether to load the map now, wait for a tap (save-data), or explain why not (offline). */
function gate(s: MapState): void {
  syncLayerInputs(s);
  if (s.canvas) return;
  const st = s.mapBox.dataset.state;
  if (st === 'loading' || (st === 'error' && s.problem !== 'offline')) return;
  if (!s.ctx.online()) {
    if (st !== 'error') showProblem(s, 'offline');
    return;
  }
  if (st === 'gated') return;
  if (shouldAutoLoadMap(s.ctx.settings.saveData, s.ctx.env.saveData, true)) {
    void startMap(s);
    return;
  }
  s.mapBox.dataset.state = 'gated';
  s.list.open = true;
  setCover(s,
    h('p', {}, 'โหมดประหยัดเน็ตเปิดอยู่ แผนที่จึงไม่โหลดเอง'),
    h('button', { class: 'primary', 'data-testid': 'map-load', onclick: () => void startMap(s) }, `แตะเพื่อโหลดแผนที่ (${MAP_DOWNLOAD_TEXT})`));
}

async function startMap(s: MapState): Promise<void> {
  if (s.canvas || s.mapBox.dataset.state === 'loading') return;
  if (typeof WebGL2RenderingContext === 'undefined') return showProblem(s, 'nogl');
  s.problem = null;
  s.importFailed = false;
  s.mapBox.dataset.state = 'loading';
  setCover(s, h('p', {}, 'กำลังโหลดแผนที่…'));
  let mod: typeof import('../map/canvas');
  try {
    mod = await import('../map/canvas');
  } catch {
    // Chromium caches a failed dynamic import() for the page's lifetime, so retrying the same
    // import() would just fail again — showProblem's "ลองใหม่" button reloads the page instead.
    s.importFailed = true;
    return showProblem(s, s.ctx.online() ? 'style' : 'offline');
  }
  const view = initialView(location.search, currentPlaces(s.ctx));
  // Assigned in the try below; the callbacks only run later, and compare against it to ignore
  // events from a map that has since been removed.
  let created: MapCanvas;
  try {
    created = mod.createMapCanvas({
      container: s.canvasHost, center: view.center, zoom: view.zoom,
      onReady: () => {
        if (s.canvas !== created) return;
        s.mapBox.dataset.state = 'ready';
        setCover(s);
        s.pin.hidden = false;
        // Fires on every idle, not just the first, so it can clear a transient tile-load message
        // left by showProblem(s, 'tiles') once the map settles again — but only that message:
        // blindly clearing status here would also wipe a pinHere() result (full/dup/outside
        // Thailand) if a drag's momentum produces a late idle shortly after the tap.
        if (s.status.textContent === PROBLEM_TH.tiles) s.status.textContent = '';
      },
      onError: (stage) => { if (s.canvas === created) showProblem(s, stage); },
      popupFor: (source, id) => popupFor(s, source, id),
      onMoveEnd: () => { if ([...s.on].some((l) => l !== 'reports')) void loadExtras(s); },
    });
  } catch (e) {
    return showProblem(s, e instanceof mod.NoWebGLError ? 'nogl' : 'style');
  }
  s.canvas = created;
  s.extraKey = null;
  s.reportsKey = null;
  syncLayerInputs(s);
  for (const l of s.on) created.setVisible(l, true);
  pushData(s);
  if (s.on.size) void loadExtras(s);
}

function showProblem(s: MapState, p: Problem): void {
  s.list.open = true;
  if (p === 'tiles') {
    s.status.textContent = PROBLEM_TH.tiles;
    return;
  }
  const c = s.canvas;
  s.canvas = null;
  if (c) setTimeout(() => c.remove(), 0); // not from inside MapLibre's own event dispatch
  s.problem = p;
  s.pin.hidden = true;
  syncLayerInputs(s);
  s.mapBox.dataset.state = 'error';
  setCover(s,
    h('p', { role: 'alert', 'data-testid': 'map-problem' }, PROBLEM_TH[p]),
    p === 'style'
      ? h('button', {
          class: 'primary', 'data-testid': 'map-retry',
          onclick: s.importFailed ? () => location.reload() : () => { s.mapBox.dataset.state = 'idle'; void startMap(s); },
        }, 'ลองใหม่')
      : null);
}

/** The layer switches only work on a loaded map; otherwise they are disabled and say why. */
function syncLayerInputs(s: MapState): void {
  const off = !s.canvas;
  for (const i of s.layerInputs) i.disabled = off;
  if (off) s.layerNote.textContent = LAYERS_NEED_MAP_TH;
  else if (s.layerNote.textContent === LAYERS_NEED_MAP_TH) s.layerNote.textContent = '';
}

function pushData(s: MapState): void {
  if (!s.canvas) return;
  s.canvas.setData('flagged', obsFeatures(s.flagged, s.grey));
  s.canvas.setData('places', placeFeatures(currentPlaces(s.ctx)));
}

function toggleLayer(s: MapState, id: ExtraLayer, on: boolean): void {
  if (on) s.on.add(id);
  else s.on.delete(id);
  s.canvas?.setVisible(id, on);
  // loadExtras only rewrites data-reports/data-extra while that group has at least one active
  // layer; turning the last one off would otherwise leave the previous count stale.
  if (!on) {
    if (id === 'reports') { s.mapBox.dataset.reports = '0'; s.reportsKey = null; }
    else if (![...s.on].some((l) => l !== 'reports')) { s.mapBox.dataset.extra = '0'; s.extraObsById.clear(); s.extraKey = null; }
  }
  void loadExtras(s);
}

/** Fill the optional layers: reports from events.json; station kinds from the obs files of the
 *  provinces in view — never more than MAX_VIEW_PROVINCES files; zoomed out, ask to zoom in. */
async function loadExtras(s: MapState): Promise<void> {
  const canvas = s.canvas;
  if (!canvas) return;
  const my = ++s.extraSeq;
  const notes: string[] = [];
  const snapshot = s.ctx.meta.generatedAt;
  if (s.on.has('reports')) {
    // Whether a report is still live depends on the time, so the key includes the minute.
    const rKey = `${snapshot}|${s.grey}|${Math.floor(s.ctx.now().getTime() / 60000)}`;
    if (rKey !== s.reportsKey) {
      try {
        const ev = await s.ctx.store.events();
        if (my !== s.extraSeq || s.canvas !== canvas) return;
        s.eventsById.clear();
        for (const e of ev.events) s.eventsById.set(e.id, e);
        s.reportsGrey = s.grey || snapshotMismatch(snapshot, [ev.generatedAt]) !== null;
        const fc = eventFeatures(ev.events, s.ctx.now(), s.reportsGrey);
        canvas.setData('reports', fc);
        s.mapBox.dataset.reports = String(fc.features.length);
        s.reportsKey = rKey;
      } catch {
        notes.push('โหลดรายงานน้ำท่วมไม่ได้');
      }
    }
  }
  const kinds = [...s.on].filter((l) => l !== 'reports');
  if (kinds.length) {
    const provinces = await s.ctx.store.provinces().catch(() => null);
    if (my !== s.extraSeq || s.canvas !== canvas) return;
    const codes = provinces ? provincesInView(canvas.bounds(), provinces) : [];
    const key = provinces ? extrasKey(snapshot, s.grey, codes, kinds) : null;
    if (key !== null && key === s.extraKey) {
      // Same provinces, kinds and snapshot as what the layer already shows: skip the refetch and
      // setData, keeping the "zoom in" note if that is what applies.
      if (codes === null) notes.push('ซูมเข้าอีกเพื่อดูสถานีของชั้นข้อมูลที่เลือก');
    } else if (codes === null) {
      notes.push('ซูมเข้าอีกเพื่อดูสถานีของชั้นข้อมูลที่เลือก');
      canvas.setData('extra', obsFeatures([], false));
      s.mapBox.dataset.extra = '0';
      s.extraObsById.clear();
      s.extraKey = key;
    } else {
      const results = await Promise.allSettled(codes.map((c) => s.ctx.store.provinceObs(c)));
      if (my !== s.extraSeq || s.canvas !== canvas) return;
      const files = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const partial = !provinces || files.length < results.length;
      if (partial) notes.push('โหลดข้อมูลบางจังหวัดไม่ได้ — ชั้นข้อมูลอาจไม่ครบ');
      const obs = files.flatMap((f) => f.obs);
      // Kept in extraObsById (not obsById) so a station that is also flagged keeps answering
      // 'flagged'-source popups with its flagged reading, never this (possibly older) one.
      s.extraObsById.clear();
      for (const o of obs) s.extraObsById.set(o.id, o);
      s.extraGrey = s.grey || snapshotMismatch(s.ctx.meta.generatedAt, files.map((f) => f.generatedAt)) !== null;
      canvas.setData('extra', obsFeatures(obs, s.extraGrey));
      s.mapBox.dataset.extra = String(obs.filter((o) => kinds.includes(o.kind)).length);
      // A partial load is retried on the next pan rather than remembered as done.
      s.extraKey = partial ? null : key;
    }
  }
  if (my === s.extraSeq) s.layerNote.textContent = notes.join(' · ');
}

/** Popup body — built with h()/textContent only, so published names and titles stay plain text. */
function popupFor(s: MapState, source: SourceId, id: string): HTMLElement | null {
  const now = s.ctx.now();
  if (source === 'reports') {
    const e = s.eventsById.get(id);
    if (!e) return null;
    const [title, ...rest] = reportPopupLines(e, now, s.reportsGrey);
    return h('div', { class: 'popup', 'data-testid': 'map-popup' }, h('strong', {}, title ?? ''), ...rest.map((t) => h('div', {}, t)));
  }
  if (source === 'places') {
    const p = currentPlaces(s.ctx).find((q) => placeKey(q) === id);
    if (!p) return null;
    return h('div', { class: 'popup', 'data-testid': 'map-popup' }, h('strong', {}, p.name), h('div', {}, h('a', { href: tabHref('home') }, 'ดูระดับความเสี่ยงของจุดนี้')));
  }
  // 'flagged' (nationwide) and 'extra' (province-file kind layers) are separate sources with
  // separate staleness, so each looks up its own map/grey flag rather than a shared one.
  const o = source === 'extra' ? s.extraObsById.get(id) : s.obsById.get(id);
  if (!o) return null;
  const grey = source === 'extra' ? s.extraGrey : s.grey;
  return h('div', { class: 'popup', 'data-testid': 'map-popup' }, h('strong', {}, o.name), ...stationPopupLines(o, now, grey).map((t) => h('div', {}, t)));
}

function pinHere(s: MapState): void {
  if (!s.canvas) return;
  const c = s.canvas.center();
  const p = pinCheck(s.canvas.zoom(), c.lat, c.lon);
  if (p === 'zoom') {
    s.status.textContent = PIN_ZOOM_TH;
    return;
  }
  if (p === 'outside') {
    s.status.textContent = 'ตำแหน่งนี้อยู่นอกประเทศไทย — เลื่อนแผนที่แล้วลองใหม่';
    return;
  }
  // Checked up front so a full list never bothers the user with the naming prompt first.
  if (currentPlaces(s.ctx).length >= MAX_PLACES) {
    s.status.textContent = FULL_TH;
    return;
  }
  const name = askPlaceName(s.ctx.kv, 'จุดบนแผนที่');
  if (name === null) return;
  // Second check: guards a same-session race (e.g. another tab filled the list while the naming
  // prompt was open).
  const result = addPlace(s.ctx, { name, ...p });
  if (result === 'full') {
    s.status.textContent = FULL_TH;
    return;
  }
  // Stays on the map (like the 'full' case above) rather than navigating to a card that was
  // already there before this tap — a silent navigation would look like nothing happened.
  if (result === 'dup') {
    s.status.textContent = 'จุดนี้มีอยู่ในรายการแล้ว';
    return;
  }
  location.href = tabHref('home'); // savePlaces already put the places into the hash
}

/** The accessible alternative to the map (and the fallback when it cannot load). */
function renderList(s: MapState, rows: StationRow[] | null, now: Date): void {
  clear(s.list);
  if (!rows) {
    s.list.append(h('summary', {}, 'รายชื่อสถานีที่น่าห่วง'), h('p', { class: 'muted' }, 'โหลดรายชื่อสถานีไม่ได้ — ลองใหม่ภายหลัง'));
    return;
  }
  s.list.append(
    h('summary', {}, `รายชื่อสถานีที่น่าห่วงทั้งประเทศ (${rows.length})`),
    rows.length
      ? h('ul', { class: 'list' }, ...rows.map((r) => h('li', { class: 'row', 'data-testid': 'map-list-row' },
        h('span', {},
          h('strong', {}, r.name), r.provTh ? ` · ${r.provTh}` : '', h('br'),
          h('span', { class: 'muted' }, [r.value, r.held ? `ค้างจาก ${fmtTime(r.t)}` : `วัดเมื่อ ${relativeAge(r.t, now)} (${fmtTime(r.t)})`].filter(Boolean).join(' · '))),
        h('span', { class: s.grey ? 'badge small grey' : 'badge small', 'data-testid': 'map-list-level', style: `background:${LEVEL_COLOR[r.level].bg};color:${LEVEL_COLOR[r.level].fg}` }, LEVEL_TH[r.level]))))
      : h('p', { class: 'muted', 'data-testid': 'map-list-empty' },
        `${s.grey ? `ณ ${fmtTime(s.dataAt)} ` : 'ตอนนี้'}ไม่มีสถานีที่อยู่ในระดับเฝ้าระวังขึ้นไป`));
}
