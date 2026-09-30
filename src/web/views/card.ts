import { passFor, type Access, type Area } from '../../core/access';
import { accessLabel, accessLine, actionLines, areaLine, confidenceLine, headlineText, NO_OFFICIAL_ORDER, passLine, situationText, trendLine, vehicleLine } from '../../core/advice';
import { groupOf, type Situation } from '../../core/situation';
import type { Vehicle } from '../../core/thresholds';
import type { Trend } from '../../core/trend';
import { LEVEL_COLOR, LEVEL_TH } from '../../core/labels';
import type { Assessment } from '../../core/risk';
import type { Level } from '../../core/types';
import { h } from '../lib/dom';
import { exitHref, mapHref } from '../lib/map-data';
import { reasonLine } from '../lib/format';
import { staleLine } from '../lib/freshness';
import type { Place } from '../lib/places';

export interface CardView {
  trend: Trend; situation: Situation; access: Access; area: Area; vehicle: 'none' | Vehicle; causes: string[]; chartStations: { id: string; km: number }[];
}

export interface CardOpts {
  place: Place; a: Assessment; shownLevel: Level; generatedAt: string; now: Date; grey: boolean;
  onShare(): void; onRemove(): void; onRename(name: string): void; compact?: boolean; coverage?: string | null;
  view: CardView; onChart(host: HTMLElement): void; onHospitals(host: HTMLElement): void; onClearExit(): void;
}

export const FAR_WITH_COVERAGE = 'ระดับนี้คิดจากหลักฐานที่อยู่ไกลหรือฝน ให้ดูสภาพจริงรอบบ้านและประกาศของอำเภอ';

export function renderCard(o: CardOpts): HTMLElement {
  const lvl = o.shownLevel;
  const color = LEVEL_COLOR[lvl];
  const badge = h('span', { class: `badge${o.grey ? ' grey' : ''}`, style: `background:${color.bg};color:${color.fg}`, 'data-testid': 'card-level' }, LEVEL_TH[lvl]);
  const stale = o.grey
    ? h('p', { class: 'muted', 'data-testid': 'card-stale' }, staleLine(o.generatedAt, o.now))
    : null;
  const held = o.shownLevel > o.a.level
    ? h('p', { class: 'muted', 'data-testid': 'card-held' }, 'ข้อมูลล่าสุดต่ำลงแล้ว — ยังแสดงระดับเดิมไว้จนกว่าจะต่ำต่อเนื่อง 30 นาที')
    : null;
  // With a coverage line (which names the nearest station), the 'far' confidence sentence would repeat the
  // distance; keep its guidance without it. Every other confidence line (e.g. level 0 "ไม่ได้แปลว่าปลอดภัย") stays.
  const farDup = !!o.coverage && lvl > 0 && o.a.confidence === 'low' && o.a.coverage.water === 'far';
  const conf = farDup ? FAR_WITH_COVERAGE : confidenceLine({ ...o.a, level: lvl });
  const group = groupOf(o.view.situation);
  const actions = actionLines(lvl, o.view.situation);
  const vehicle = vehicleLine(o.a.vehicleDepthCm);
  const sitText = situationText(o.view.situation, o.view.trend);
  const headline = h('p', { 'data-testid': 'card-headline', 'data-situation': o.view.situation }, h('strong', {}, sitText ?? headlineText({ ...o.a, level: lvl })));
  const trendText = trendLine(o.view.trend);
  const trendEl = trendText ? h('p', { 'data-testid': 'card-trend' }, trendText) : null;
  const facets = lvl >= 1 ? h('dl', { class: 'facets', 'data-testid': 'card-facets' },
    h('div', { 'data-testid': 'facet-property' }, h('dt', {}, 'จุดนี้'), h('dd', {}, LEVEL_TH[lvl])),
    h('div', { 'data-testid': 'facet-access' }, h('dt', {}, accessLabel(o.view.access.at)), h('dd', {}, accessLine(o.view.access))),
    h('div', { 'data-testid': 'facet-area' }, h('dt', {}, 'ย่าน 3 กม.'), h('dd', {}, areaLine(o.view.area)))) : null;
  const v = o.view.vehicle;
  const vehicleText = v === 'none' ? (vehicle ? `🚗 ${vehicle}` : null) : passLine(v, passFor(v, o.view.access), o.view.access);
  const vehicleEl = vehicleText ? h('p', { 'data-testid': 'card-vehicle' }, vehicleText) : null;
  const causes = (group === 'approach' || group === 'flooded') && o.view.causes.length
    ? h('div', { 'data-testid': 'card-causes' }, h('p', {}, h('strong', {}, 'ทำไมน้ำยังขึ้น')), h('ul', {}, ...o.view.causes.map((t) => h('li', {}, t))))
    : null;
  const why = h('details', { 'data-testid': 'card-why' },
    h('summary', {}, 'ทำไม?'),
    h('ul', {}, ...o.a.reasons.slice(0, 3).map((r) => h('li', {}, reasonLine(r, o.now)))),
    o.a.reasons.length === 0 ? h('p', { class: 'muted' }, 'ไม่มีสถานีหรือรายงานใกล้จุดนี้') : null,
    o.view.chartStations.length === 0 ? h('p', { class: 'muted' }, 'ไม่มีสถานีวัดระดับน้ำใกล้จุดนี้ จึงไม่มีกราฟ') : null);
  // Compact mode (more than 3 places) keeps each card to a couple of lines, but the advice and the
  // reasons stay one tap away; from เตือนภัย (3) up the actions are never hidden.
  const folded = o.compact === true && lvl < 3;
  const actionList = actions.length ? h('ul', { 'data-testid': 'card-actions' }, ...actions.map((t) => h('li', {}, t))) : null;
  const chartHost = h('div', { 'data-testid': 'card-chart-host', hidden: true });
  let chartLoaded = false;
  const chartBtn: HTMLElement | null = o.view.chartStations.length > 0 ? h('button', { 'data-testid': 'card-chart', 'aria-expanded': 'false', onclick: () => {
    chartHost.hidden = !chartHost.hidden;
    chartBtn?.setAttribute('aria-expanded', String(!chartHost.hidden));
    if (!chartHost.hidden && !chartLoaded) { chartLoaded = true; o.onChart(chartHost); }
  } }, 'กราฟ 7 วัน') : null;
  const hospHost = h('div', { 'data-testid': 'card-hospitals-body' });
  let hospLoaded = false;
  const hospitals = h('details', { 'data-testid': 'card-hospitals', ontoggle: (e: Event) => {
    if ((e.target as HTMLDetailsElement).open && !hospLoaded) { hospLoaded = true; o.onHospitals(hospHost); }
  } }, h('summary', {}, 'โรงพยาบาลใกล้จุดนี้'), hospHost);
  const rename = () => {
    const name = prompt('ตั้งชื่อจุดนี้', o.place.name);
    if (name !== null) o.onRename(name);
  };
  const ariaLabel = `${o.place.name}: ${LEVEL_TH[lvl]}${o.grey ? ' (ข้อมูลเก่า อาจไม่ตรงกับตอนนี้)' : ''}`;
  return h('article', { class: 'card', 'data-testid': 'card', 'aria-label': ariaLabel },
    h('h2', {}, o.place.name),
    badge,
    stale,
    headline,
    held,
    trendEl,
    conf ? h('p', { class: 'muted', 'data-testid': 'card-confidence' }, conf) : null,
    o.coverage ? h('p', { class: 'muted', 'data-testid': 'card-coverage' }, o.coverage) : null,
    folded ? null : facets,
    folded ? null : vehicleEl,
    folded ? null : causes,
    folded ? null : actionList,
    lvl === 4
      ? h('p', { class: 'actions' },
        h('a', { href: 'tel:1784', class: 'callbtn', 'aria-label': 'โทร 1784 ปภ. ช่วยเหลือผู้ประสบภัย' }, 'โทร 1784'),
        h('a', { href: 'tel:1669', class: 'callbtn', 'aria-label': 'โทร 1669 เจ็บป่วยฉุกเฉิน' }, 'โทร 1669'))
      : null,
    folded
      ? h('details', { 'data-testid': 'card-more' }, h('summary', {}, 'ดูสิ่งที่ควรทำและเหตุผล'), facets, vehicleEl, causes, actionList, why)
      : why,
    h('div', { class: 'actions' },
      h('button', { onclick: o.onShare, 'data-testid': 'card-share' }, 'แชร์'),
      chartBtn,
      h('a', { class: 'btnlink', href: mapHref(o.place, location.hash), 'data-testid': 'card-map' }, 'ดูบนแผนที่'),
      h('a', { class: 'btnlink', href: exitHref(o.place, location.hash), 'data-testid': 'card-exit' }, o.place.exit ? 'แก้ทางออก' : 'ปักทางออก'),
      o.place.exit ? h('button', { 'data-testid': 'card-exit-clear', onclick: () => { if (confirm('ลบทางออกของจุดนี้?')) o.onClearExit(); } }, 'ลบทางออก') : null,
      h('button', { onclick: rename }, 'แก้ชื่อ'),
      h('button', { onclick: () => { if (confirm(`ลบ "${o.place.name}"?`)) o.onRemove(); } }, 'ลบ')),
    chartHost,
    hospitals,
    o.compact ? null : h('p', { class: 'muted' }, NO_OFFICIAL_ORDER));
}
