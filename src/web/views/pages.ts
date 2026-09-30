import { AREA_NOTE_TH, DISCLAIMER_TH, EMERGENCY, LEVEL_COLOR, LEVEL_TH } from '../../core/labels';
import { SIGNAL_SETS, TRUTHS, type SkillFile } from '../../core/skill';
import { WATER_SOURCE_TH } from '../../core/source-watch';
import { BKK_METRO, DAM, FRESH_MIN, THRESHOLDS_VERSION } from '../../core/thresholds';
import { fmtDateTime } from '../../core/time';
import { ALERTS_PRIVACY_TH, alertsCfg, alertsOn, pushConfigured } from '../lib/alerts-state';
import type { AreaRow } from '../lib/data';
import { clear, h } from '../lib/dom';
import { freshness, staleLine } from '../lib/freshness';
import { normalizeThai } from '../lib/search';
import { applySettings, saveSettings, type Settings } from '../lib/settings';
import { hitText, LEVEL_KEY_TH, precText, SIGNAL_TH, SKILL_NONE_TH, SKILL_NOTE_TH, staleText, targetText, TRACK_TH, trackState, TRUTH_TH, windowText } from '../lib/skill-text';
import { loadPlaces, type AppCtx } from './home';
import { tabLink, type Tab } from './shell';

const SOURCE_TH: Record<string, string> = {
  river: `${WATER_SOURCE_TH.river} — สสน. (ThaiWater)`, rain: `${WATER_SOURCE_TH.rain} — สสน. (ThaiWater)`, road: `${WATER_SOURCE_TH.road} — สสน. (ThaiWater)`,
  canal: `${WATER_SOURCE_TH.canal} — สสน. (ThaiWater)`, dam: 'เขื่อน — สสน. (ThaiWater)', longdo: 'เหตุการณ์บนถนน — Longdo Traffic',
  traffy: 'ประชาชนแจ้ง — Traffy Fondue (ยังไม่ยืนยัน)', forecast: 'พยากรณ์ฝน — Open-Meteo', tmd: 'ประกาศเตือน — กรมอุตุนิยมวิทยา',
  hospitals: 'โรงพยาบาล (OSM)', bma: 'กทม. (relay)',
};

export async function renderPage(tab: Exclude<Tab, 'home' | 'map'>, ctx: AppCtx): Promise<void> {
  const main = ctx.shell.main;
  clear(main);
  if (tab === 'areas') return areas(ctx, main);
  if (tab === 'help') return help(main);
  if (tab === 'sources') return sources(ctx, main);
  return about(ctx, main);
}

async function areas(ctx: AppCtx, main: HTMLElement): Promise<void> {
  const q = h('input', { type: 'search', 'aria-label': 'ค้นหาจังหวัดหรือเขต', placeholder: 'ค้นหาจังหวัดหรือเขต' });
  const list = h('div', { 'data-testid': 'areas-list' });
  let all: AreaRow[];
  try {
    all = await ctx.store.areas();
  } catch {
    list.append(h('p', { class: 'muted' }, 'โหลดรายชื่อพื้นที่ไม่ได้ — ลองใหม่ภายหลัง'));
    main.append(h('h1', {}, 'รายพื้นที่'), h('p', { class: 'muted' }, AREA_NOTE_TH), q, list);
    return;
  }
  const now = ctx.now();
  const fr = freshness(ctx.meta.generatedAt, now, ctx.online());
  const sorted = [...all].sort((x, y) => y.level - x.level || x.name.localeCompare(y.name, 'th'));
  const norm = sorted.map((a) => normalizeThai(a.name));
  const draw = () => {
    clear(list);
    // Same normalisation as the home search (prefixes จ./เขต/…, spaces and tone marks ignored).
    const term = normalizeThai(q.value);
    sorted.forEach((a, i) => {
      if (term && !norm[i]!.includes(term)) return;
      list.append(h('div', { class: 'row' },
        h('a', { href: `./p/${a.code}.html` }, a.kind === 'district' ? `เขต${a.name}` : a.name),
        h('span', { class: fr.grey ? 'badge grey' : 'badge', 'data-testid': 'area-level', style: `background:${LEVEL_COLOR[a.level].bg};color:${LEVEL_COLOR[a.level].fg};font-size:1rem` }, LEVEL_TH[a.level])));
    });
  };
  q.addEventListener('input', draw);
  draw();
  main.append(h('h1', {}, 'รายพื้นที่'),
    ...(fr.grey ? [h('p', { class: 'muted', 'data-testid': 'areas-stale' }, staleLine(ctx.meta.generatedAt, now))] : []),
    h('p', { class: 'muted' }, AREA_NOTE_TH), q, list);
}

function help(main: HTMLElement): void {
  main.append(h('section', { 'data-testid': 'help' },
    h('h1', {}, 'ช่วยเหลือ'),
    h('p', {}, h('strong', {}, 'เว็บนี้ไม่รับแจ้งเหตุ'), ' — ติดต่อช่องทางทางการด้านล่าง'),
    h('ul', { class: 'list' }, ...EMERGENCY.map((e) => h('li', { class: 'row' }, h('a', { href: `tel:${e.tel}`, 'aria-label': `โทร ${e.tel} ${e.th}` }, `โทร ${e.tel}`), ` — ${e.th}`))),
    h('ul', { class: 'list' },
      h('li', { class: 'row' }, h('a', { href: 'https://www.disaster.go.th/', rel: 'noopener' }, 'กรมป้องกันและบรรเทาสาธารณภัย (ปภ.) — ศูนย์พักพิงและประกาศ')),
      h('li', { class: 'row' }, h('a', { href: 'https://share.traffy.in.th/teamchadchart', rel: 'noopener' }, 'Traffy Fondue — แจ้งปัญหาในกรุงเทพฯ')),
      h('li', { class: 'row' }, h('a', { href: 'https://www.bangkok.go.th/', rel: 'noopener' }, 'กรุงเทพมหานคร — ประกาศและศูนย์พักพิง'))),
    h('h2', {}, 'ความปลอดภัยเมื่อน้ำท่วม'),
    h('ul', {},
      h('li', {}, 'ถ้าน้ำเริ่มเข้าบ้าน ตัดไฟที่เบรกเกอร์ก่อน อย่าแตะอุปกรณ์ไฟฟ้าขณะตัวเปียก'),
      h('li', {}, 'อย่าลุยน้ำสูงเกินเข่า และอย่าขับรถผ่านน้ำไหลแรง'),
      h('li', {}, 'ระวังไฟดูด สัตว์มีพิษ และของมีคมใต้น้ำ'),
      h('li', {}, 'เตรียมถุงยังชีพ: ยาประจำตัว เอกสารสำคัญในถุงกันน้ำ ไฟฉาย น้ำดื่ม พาวเวอร์แบงก์')),
    h('p', { class: 'muted' }, DISCLAIMER_TH)));
}

function sources(ctx: AppCtx, main: HTMLElement): void {
  const m = ctx.meta;
  const table = h('table', { 'data-testid': 'sources-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'แหล่ง'), h('th', {}, 'สถานะ'))),
    h('tbody', {}, ...m.sources.map((s) => h('tr', {},
      h('td', {}, s.viaBma ? (SOURCE_TH[s.id] ?? s.id).replace('สสน. (ThaiWater)', 'สสน. + กทม.') : SOURCE_TH[s.id] ?? s.id),
      h('td', {}, s.ok ? `ปกติ · ${s.count} รายการ${s.lagMin !== null ? ` · ช้า ${s.lagMin} นาที` : ''}${s.viaBma && s.twLagMin != null && s.twLagMin > 60 ? ` · สสน. ค้าง ${Math.round(s.twLagMin / 60)} ชม. — ใช้ข้อมูล กทม.` : ''}${s.viaBma && s.error ? ` (สสน.: ${s.error})` : ''}`
        : s.carriedFrom ? `ใช้ข้อมูลค้างจาก ${fmtDateTime(s.carriedFrom)} (${s.error ?? 'ดึงไม่สำเร็จ'})` : `ดึงไม่สำเร็จ (${s.error ?? ''})`)))));
  const skillBox = h('section', { 'data-testid': 'skill' }, h('h2', {}, 'ความแม่นย้อนหลัง'), h('p', { class: 'muted' }, 'กำลังโหลด…'));
  main.append(h('section', {},
    h('h1', {}, 'แหล่งข้อมูลและเกณฑ์'),
    h('p', {}, `อัปเดตล่าสุด ${fmtDateTime(m.generatedAt)} · เกณฑ์รุ่น ${THRESHOLDS_VERSION}${m.thresholdsVersion !== THRESHOLDS_VERSION ? ` (ข้อมูลใช้รุ่น ${m.thresholdsVersion})` : ''}`),
    table,
    h('p', {}, 'ไม่มีรายงาน ≠ ไม่ท่วม — รายงานประชาชนครอบคลุมเฉพาะบางพื้นที่ (Traffy เฉพาะกรุงเทพฯ)'),
    h('h2', {}, 'เกณฑ์โดยย่อ'),
    h('ul', {},
      h('li', {}, 'แม่น้ำ: ล้นตลิ่ง = อันตราย · ต่ำกว่าตลิ่ง ≤20 ซม. = เตือนภัย · ≤50 ซม. = เฝ้าระวัง'),
      h('li', {}, 'คลอง กทม.: ล้นตลิ่ง = อันตราย · ต่ำกว่าตลิ่ง <30 ซม. = เตือนภัย · <60 ซม. หรือเกินเกณฑ์วิกฤตของ กทม. = เฝ้าระวัง'),
      h('li', {}, 'น้ำบนถนน: ≥30 ซม. = อันตราย · ≥10 ซม. = เตือนภัย · ≥5 ซม. = เฝ้าระวัง'),
      h('li', {}, `ฝน (กทม. และปริมณฑล ${BKK_METRO.length} จังหวัด): 1 ชม. ≥30 มม. หรือ 3 ชม. ≥60 มม. = เฝ้าระวัง · 1 ชม. ≥60 หรือ 3 ชม. ≥100 = เตือนภัย`),
      h('li', {}, 'ฝน (จังหวัดอื่น): 24 ชม. ≥90 มม. = เฝ้าระวัง · ≥150 มม. = เตือนภัย'),
      h('li', {}, `เขื่อน: ปริมาณน้ำ ≥${DAM.l2}% ของความจุ = เฝ้าระวัง`),
      h('li', {}, `ข้อมูลเก่ากว่าเกณฑ์ไม่ถูกนับ (แม่น้ำ ${FRESH_MIN.river / 60} ชม. · ฝน ${FRESH_MIN.rain / 60} ชม. · ถนน ${FRESH_MIN.road / 60} ชม. · คลอง ${FRESH_MIN.canal / 60} ชม.)`),
      h('li', {}, 'ระดับ "อันตราย" ต้องมีหลักฐานโดยตรงใกล้จุด ฝนหรือพยากรณ์อย่างเดียวไม่ถึงระดับนี้')),
    ...(m.tmd.length ? [h('h2', {}, 'ประกาศกรมอุตุนิยมวิทยา'), ...m.tmd.map((w) => h('div', { class: 'card' }, h('strong', {}, w.title), h('p', {}, w.body)))] : []),
    skillBox));
  void ctx.store.skill().then((s) => renderSkill(skillBox, s, ctx.now()));
}

function renderSkill(box: HTMLElement, s: SkillFile | null, now: Date): void {
  clear(box);
  box.append(h('h2', {}, 'ความแม่นย้อนหลัง'));
  if (!s) {
    box.append(h('p', { 'data-testid': 'skill-none' }, SKILL_NONE_TH));
    return;
  }
  const stale = staleText(s, now);
  box.append(
    h('p', { class: 'muted' }, SKILL_NOTE_TH),
    h('p', {}, `คำนวณเมื่อ ${fmtDateTime(s.generatedAt)}${s.thresholdsVersion !== THRESHOLDS_VERSION ? ` · คำนวณด้วยเกณฑ์รุ่น ${s.thresholdsVersion}` : ''}`),
    ...(stale ? [h('p', { class: 'muted', 'data-testid': 'skill-stale' }, stale)] : []),
    h('p', { 'data-testid': 'skill-target' }, targetText(s.target)));
  for (const key of ['7', '30'] as const) {
    const w = s.windows[key];
    const card = h('div', { class: 'card', 'data-testid': `skill-${key}` }, h('h3', {}, windowText(w, key)),
      h('p', { class: 'muted', 'data-testid': `skill-${key}-signals` }, `ระดับที่วัด: ${SIGNAL_TH.all}`));
    for (const truth of TRUTHS) {
      card.append(
        h('h4', {}, TRUTH_TH[truth]),
        h('p', { 'data-testid': `skill-${key}-${truth}-track` }, `เทียบเป้า: ${TRACK_TH[trackState(w, truth, s.target)]}`));
      for (const lk of ['3', '2'] as const) {
        const m = w.truths[truth].all[lk];
        card.append(h('p', {}, h('strong', {}, LEVEL_KEY_TH[lk]), h('br'), hitText(m, s.minN, w.evidence[truth], truth), h('br'), precText(m, s.minN, truth)));
      }
      const per = h('details', {}, h('summary', {}, 'แยกตามชนิดสัญญาณ'));
      for (const sig of SIGNAL_SETS) {
        if (sig === 'all') continue;
        for (const lk of ['3', '2'] as const) {
          const m = w.truths[truth][sig][lk];
          per.append(h('p', {}, `${SIGNAL_TH[sig]} · ${LEVEL_KEY_TH[lk]}: ${hitText(m, s.minN, w.evidence[truth], truth)} · ${precText(m, s.minN, truth)}`));
        }
      }
      card.append(per);
    }
    box.append(card);
  }
}

function about(ctx: AppCtx, main: HTMLElement): void {
  const s: Settings = { ...ctx.settings };
  const sizeBtns: { el: HTMLButtonElement; val: Settings['size'] }[] = [];
  const themeBtns: { el: HTMLButtonElement; val: Settings['theme'] }[] = [];
  const vehBtns: { el: HTMLButtonElement; val: Settings['vehicle'] }[] = [];
  const syncPressed = () => {
    for (const { el, val } of sizeBtns) el.setAttribute('aria-pressed', String(s.size === val));
    for (const { el, val } of themeBtns) el.setAttribute('aria-pressed', String(s.theme === val));
    for (const { el, val } of vehBtns) el.setAttribute('aria-pressed', String(s.vehicle === val));
  };
  const set = (patch: Partial<Settings>) => { Object.assign(s, patch); Object.assign(ctx.settings, patch); saveSettings(ctx.kv, s); applySettings(document, s); syncPressed(); };
  const sizeA = h('button', { onclick: () => set({ size: 'a' }), 'aria-pressed': String(s.size === 'a') }, 'ก ปกติ');
  const sizeA2 = h('button', { onclick: () => set({ size: 'a2' }), style: 'font-size:1.15rem', 'aria-pressed': String(s.size === 'a2') }, 'ก ใหญ่');
  const sizeA3 = h('button', { onclick: () => set({ size: 'a3' }), style: 'font-size:1.3rem', 'data-testid': 'size-a3', 'aria-pressed': String(s.size === 'a3') }, 'ก ใหญ่มาก');
  sizeBtns.push({ el: sizeA, val: 'a' }, { el: sizeA2, val: 'a2' }, { el: sizeA3, val: 'a3' });
  const themeAuto = h('button', { onclick: () => set({ theme: 'auto' }), 'aria-pressed': String(s.theme === 'auto') }, 'ตามเครื่อง');
  const themeLight = h('button', { onclick: () => set({ theme: 'light' }), 'aria-pressed': String(s.theme === 'light') }, 'สว่าง');
  const themeDark = h('button', { onclick: () => set({ theme: 'dark' }), 'aria-pressed': String(s.theme === 'dark') }, 'มืด');
  themeBtns.push({ el: themeAuto, val: 'auto' }, { el: themeLight, val: 'light' }, { el: themeDark, val: 'dark' });
  const vehOpts: [Settings['vehicle'], string][] = [['none', 'ไม่ระบุ'], ['walk', 'เดิน'], ['motorcycle', 'มอเตอร์ไซค์'], ['car', 'รถเก๋ง'], ['pickup', 'กระบะ/SUV']];
  for (const [val, label] of vehOpts) vehBtns.push({ el: h('button', { onclick: () => set({ vehicle: val }), 'aria-pressed': String(s.vehicle === val), 'data-testid': `vehicle-${val}` }, label), val });
  // Also when alerts are off in this build but this phone still says on: it shows the paused state (I3).
  const alertsMenu = pushConfigured(alertsCfg()) || alertsOn(ctx.kv) ? h('section', { 'data-testid': 'alerts-menu' }) : null;
  if (alertsMenu) {
    void import('./alerts').then((m) => m.renderAlertsMenu(alertsMenu, { kv: ctx.kv, base: ctx.base, shell: ctx.shell, getPlaces: () => loadPlaces(ctx.kv) })).catch(() => alertsMenu.remove());
  }
  main.append(
    h('h1', {}, 'เมนู'),
    h('nav', { 'aria-label': 'เมนู', 'data-testid': 'menu' },
      h('ul', { class: 'list' },
        h('li', { class: 'row' }, tabLink('sources', {}, 'แหล่งข้อมูลและเกณฑ์')),
        h('li', { class: 'row' }, h('a', { href: './p/index.html' }, 'ความเสี่ยงรายจังหวัดและรายเขต (ไม่ต้องใช้ JavaScript)')))),
    h('section', { 'data-testid': 'settings' },
      h('h2', {}, 'ตั้งค่า'),
      h('div', { class: 'actions', role: 'group', 'aria-label': 'ขนาดตัวอักษร' }, sizeA, sizeA2, sizeA3),
      h('div', { class: 'actions', role: 'group', 'aria-label': 'ธีม' }, themeAuto, themeLight, themeDark),
      h('p', {}, 'ฉันเดินทางด้วย (ใช้บอกว่าผ่านน้ำบนถนนได้ไหม)'),
      h('div', { class: 'actions', role: 'group', 'aria-label': 'ยานพาหนะ' }, ...vehBtns.map((b) => b.el)),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.saveData, onchange: (e: Event) => set({ saveData: (e.target as HTMLInputElement).checked }) }), ' โหมดประหยัดเน็ต (ไม่โหลดแผนที่เอง)')),
    ...(alertsMenu ? [alertsMenu] : []),
    h('section', { 'data-testid': 'about' },
      h('h2', {}, 'เกี่ยวกับ'),
      h('p', {}, 'ท่วมไหม ทำโดยอาสาสมัคร ไม่ใช่หน่วยงานทางการ ใช้เพื่อประเมินสถานการณ์และเตรียมพร้อม — ทำตามประกาศของหน่วยงานเสมอ'),
      h('p', {}, ALERTS_PRIVACY_TH),
      h('h2', {}, 'เครดิตและสัญญาอนุญาต'),
      h('ul', {},
        h('li', {}, 'ข้อมูลน้ำและฝน: สถาบันสารสนเทศทรัพยากรน้ำ (สสน.) — ThaiWater'),
        h('li', {}, 'เหตุการณ์บนถนนและกล้อง: Longdo Traffic / iTIC'),
        h('li', {}, 'รายงานประชาชน: Traffy Fondue'),
        h('li', {}, 'พยากรณ์ฝน: Open-Meteo (CC BY 4.0)'),
        h('li', {}, 'ประกาศเตือน: กรมอุตุนิยมวิทยา'),
        h('li', {}, 'ขอบเขตการปกครองและรายชื่อตำบล: OCHA COD-AB Thailand (CC BY-IGO)'),
        h('li', {}, 'แผนที่พื้นฐาน: OpenFreeMap · © OpenMapTiles · ข้อมูลแผนที่ © ผู้ร่วมพัฒนา OpenStreetMap (ODbL)'),
        h('li', {}, 'ค้นหาสถานที่: Nominatim · © ผู้ร่วมพัฒนา OpenStreetMap (ODbL)'),
        h('li', {}, 'ข้อมูลโรงพยาบาล: © ผู้ร่วมพัฒนา OpenStreetMap (ODbL)'),
        h('li', {}, 'ไลบรารีแผนที่: MapLibre GL JS (BSD-3-Clause) — ', h('a', { href: './licenses/maplibre-gl.txt', 'data-testid': 'maplibre-license' }, 'ข้อความสัญญาอนุญาต')),
        h('li', {}, 'ฟอนต์: Noto Sans Thai Looped (SIL Open Font License)')),
      h('p', { class: 'muted' }, DISCLAIMER_TH)));
}
