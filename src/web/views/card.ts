import { actionLines, confidenceLine, headlineText, NO_OFFICIAL_ORDER, vehicleLine } from '../../core/advice';
import { LEVEL_COLOR, LEVEL_TH } from '../../core/labels';
import type { Assessment } from '../../core/risk';
import type { Level } from '../../core/types';
import { h } from '../lib/dom';
import { reasonLine } from '../lib/format';
import { staleLine } from '../lib/freshness';
import type { Place } from '../lib/places';

export interface CardOpts {
  place: Place; a: Assessment; shownLevel: Level; generatedAt: string; now: Date; grey: boolean;
  onShare(): void; onRemove(): void; onRename(name: string): void; compact?: boolean;
}

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
  const conf = confidenceLine({ ...o.a, level: lvl });
  const actions = actionLines(lvl);
  const vehicle = vehicleLine(o.a.vehicleDepthCm);
  const why = h('details', { 'data-testid': 'card-why' },
    h('summary', {}, 'ทำไม?'),
    h('ul', {}, ...o.a.reasons.slice(0, 3).map((r) => h('li', {}, reasonLine(r, o.now)))),
    o.a.reasons.length === 0 ? h('p', { class: 'muted' }, 'ไม่มีสถานีหรือรายงานใกล้จุดนี้') : null);
  // Compact mode (more than 3 places) keeps each card to a couple of lines, but the advice and the
  // reasons stay one tap away; from เตือนภัย (3) up the actions are never hidden.
  const folded = o.compact === true && lvl < 3;
  const actionList = actions.length ? h('ul', { 'data-testid': 'card-actions' }, ...actions.map((t) => h('li', {}, t))) : null;
  const vehicleLineEl = vehicle ? h('p', {}, `🚗 ${vehicle}`) : null;
  const rename = () => {
    const name = prompt('ตั้งชื่อจุดนี้', o.place.name);
    if (name !== null) o.onRename(name);
  };
  const ariaLabel = `${o.place.name}: ${LEVEL_TH[lvl]}${o.grey ? ' (ข้อมูลเก่า อาจไม่ตรงกับตอนนี้)' : ''}`;
  return h('article', { class: 'card', 'data-testid': 'card', 'aria-label': ariaLabel },
    h('h2', {}, o.place.name),
    badge,
    stale,
    h('p', { 'data-testid': 'card-headline' }, h('strong', {}, headlineText({ ...o.a, level: lvl }))),
    held,
    conf ? h('p', { class: 'muted', 'data-testid': 'card-confidence' }, conf) : null,
    folded ? null : actionList,
    folded ? null : vehicleLineEl,
    lvl === 4
      ? h('p', { class: 'actions' },
        h('a', { href: 'tel:1784', class: 'callbtn', 'aria-label': 'โทร 1784 ปภ. ช่วยเหลือผู้ประสบภัย' }, 'โทร 1784'),
        h('a', { href: 'tel:1669', class: 'callbtn', 'aria-label': 'โทร 1669 เจ็บป่วยฉุกเฉิน' }, 'โทร 1669'))
      : null,
    folded
      ? h('details', { 'data-testid': 'card-more' }, h('summary', {}, 'ดูสิ่งที่ควรทำและเหตุผล'), actionList, vehicleLineEl, why)
      : why,
    h('div', { class: 'actions' },
      h('button', { onclick: o.onShare, 'data-testid': 'card-share' }, 'แชร์'),
      h('button', { onclick: rename }, 'แก้ชื่อ'),
      h('button', { onclick: () => { if (confirm(`ลบ "${o.place.name}"?`)) o.onRemove(); } }, 'ลบ')),
    o.compact ? null : h('p', { class: 'muted' }, NO_OFFICIAL_ORDER));
}
