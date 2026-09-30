import type { WeekFile } from '../../core/week';
import type { DataStore } from '../lib/data';
import { clear, h } from '../lib/dom';
import { distanceText } from '../../core/advice';
import { staleLine } from '../lib/freshness';
import { dailyRows, dayLabel, refLines, segments, summaryLine, valueText, yDomain } from '../lib/week-chart';

const W = 320;
const HGT = 160;
const PAD = { l: 44, r: 8, t: 8, b: 22 };
const NS = 'http://www.w3.org/2000/svg';
const KIND_TH = { river: 'แม่น้ำ', canal: 'คลอง', road: 'ถนน' } as const;

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function chart(f: WeekFile, km: number, nowMs: number): HTMLElement {
  const refs = refLines(f);
  const [lo, hi] = yDomain(f, refs);
  const x0 = f.t0 * 1000;
  const x1 = Math.max(nowMs, x0 + (f.v.length - 1) * f.step * 1000);
  const sx = (t: number) => PAD.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - PAD.l - PAD.r);
  const sy = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (HGT - PAD.t - PAD.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${HGT}`, class: 'weekchart', role: 'img', 'aria-label': `กราฟ 7 วัน ${f.name}: ${summaryLine(f)}`, 'data-testid': 'week-svg' });
  // day gridlines + labels (Bangkok midnight)
  const day = 86400e3;
  for (let t = Math.ceil((x0 + 7 * 3600e3) / day) * day - 7 * 3600e3; t <= x1; t += day) {
    svg.append(s('line', { x1: sx(t), x2: sx(t), y1: PAD.t, y2: HGT - PAD.b, class: 'grid' }));
    const lbl = s('text', { x: sx(t) + 2, y: HGT - 6, class: 'axis' }); lbl.textContent = dayLabel(t); svg.append(lbl);
  }
  // y axis min/max labels
  for (const v of [lo, hi]) {
    const t = s('text', { x: PAD.l - 4, y: sy(v) + 4, class: 'axis', 'text-anchor': 'end' });
    t.textContent = f.kind === 'road' ? `${Math.round(v)}` : v.toFixed(2); svg.append(t);
  }
  for (const r of refs) {
    svg.append(s('line', { x1: PAD.l, x2: W - PAD.r, y1: sy(r.v), y2: sy(r.v), class: 'ref' }));
    const t = s('text', { x: PAD.l + 2, y: sy(r.v) - 3, class: 'reflabel', 'text-anchor': 'start' }); t.textContent = r.label; svg.append(t);
  }
  for (const seg of segments(f)) {
    if (seg.length === 1) svg.append(s('circle', { cx: sx(seg[0]!.t), cy: sy(seg[0]!.v), r: 3, class: 'dot' }));
    else svg.append(s('polyline', { points: seg.map((p) => `${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' '), class: 'series' }));
  }
  svg.append(s('line', { x1: sx(nowMs), x2: sx(nowMs), y1: PAD.t, y2: HGT - PAD.b, class: 'now' }));
  const nowLbl = s('text', { x: sx(nowMs) - 3, y: PAD.t + 9, class: 'axis', 'text-anchor': 'end' }); nowLbl.textContent = 'ตอนนี้'; svg.append(nowLbl);
  // crosshair + readout (hover/touch)
  const cross = s('line', { x1: 0, x2: 0, y1: PAD.t, y2: HGT - PAD.b, class: 'cross', visibility: 'hidden' });
  svg.append(cross);
  const readout = h('p', { class: 'muted', role: 'status', 'data-testid': 'week-readout' }, 'แตะกราฟเพื่อดูค่าแต่ละชั่วโมง');
  const onMove = (e: PointerEvent) => {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const t = x0 + ((x - PAD.l) / (W - PAD.l - PAD.r)) * (x1 - x0);
    const i = Math.round((t / 1000 - f.t0) / f.step);
    const v = f.v[i];
    if (i < 0 || i >= f.v.length || v === null || v === undefined) { cross.setAttribute('visibility', 'hidden'); readout.textContent = 'ไม่มีข้อมูลชั่วโมงนี้'; return; }
    const ti = (f.t0 + i * f.step) * 1000;
    cross.setAttribute('x1', String(sx(ti))); cross.setAttribute('x2', String(sx(ti))); cross.setAttribute('visibility', 'visible');
    const d = new Date(ti + 7 * 3600e3);
    readout.textContent = `${dayLabel(ti)} ${String(d.getUTCHours()).padStart(2, '0')}:00 · ${valueText(f, v)}`;
  };
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerdown', onMove);

  const rows = dailyRows(f);
  const fmt = (v: number) => (f.kind === 'road' ? `${Math.round(v)}` : v.toFixed(2));
  const table = h('table', { class: 'weektable', hidden: true, 'data-testid': 'week-table' },
    h('caption', {}, `${f.name} — รายวัน (${f.kind === 'road' ? 'ซม.' : 'ม.รทก.'})`),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'วัน'), h('th', { scope: 'col' }, 'ต่ำสุด'), h('th', { scope: 'col' }, 'สูงสุด'), h('th', { scope: 'col' }, 'ล่าสุด'))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.day), h('td', {}, fmt(r.min)), h('td', {}, fmt(r.max)), h('td', {}, fmt(r.last))))));
  const toggle = h('button', { 'data-testid': 'week-table-toggle', 'aria-expanded': 'false', onclick: () => { table.hidden = !table.hidden; toggle.setAttribute('aria-expanded', String(!table.hidden)); toggle.textContent = table.hidden ? 'ดูเป็นตาราง' : 'ซ่อนตาราง'; } }, 'ดูเป็นตาราง');
  const young = f.v.length < 24 ? h('p', { class: 'muted' }, 'เพิ่งเริ่มเก็บข้อมูล กราฟจะครบ 7 วันภายในสัปดาห์นี้') : null;
  return h('figure', { class: 'week', 'data-testid': 'week-chart' },
    h('figcaption', {}, h('strong', {}, f.name), ` · ${KIND_TH[f.kind]} · ${distanceText(km)}`),
    svg, readout, h('p', { 'data-testid': 'week-summary' }, summaryLine(f)), young, toggle, table);
}

export async function mountWeekCharts(host: HTMLElement, store: DataStore, stations: { id: string; km: number }[], now: Date): Promise<void> {
  clear(host);
  host.append(h('p', { class: 'muted' }, 'กำลังโหลดกราฟ…'));
  const results = await Promise.allSettled(stations.map((st) => store.week(st.id)));
  clear(host);
  let failed = false;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const f = r.value;
      host.append(chart(f, stations[i]!.km, now.getTime()));
      const meta = store.generatedAt();
      if (meta && Date.parse(f.generatedAt) < Date.parse(meta)) host.append(h('p', { class: 'muted' }, staleLine(f.generatedAt, now)));
    } else failed = true;
  });
  if (failed) {
    host.append(h('p', { role: 'alert', 'data-testid': 'week-error' }, 'โหลดกราฟไม่ได้ ',
      h('button', { 'data-testid': 'week-retry', onclick: () => void mountWeekCharts(host, store, stations, now) }, 'ลองใหม่')));
  }
}
