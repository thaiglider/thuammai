import { actionLines, distanceText, headlineText, NO_OFFICIAL_ORDER } from './advice';
import { LEVEL_TH } from './labels';
import type { Assessment } from './risk';
import type { TrendKind } from './trend-alert';
import type { Trend } from './trend';
import { fmtTime } from './time';
import type { Level } from './types';

export const ALERT_TEXT_MAX = 500;
export const PUSH_PAYLOAD_MAX_BYTES = 1500;
export const LOW_CONF_TH = 'ความมั่นใจต่ำ — ดูสภาพจริงรอบบ้าน';
/** Same sentence as the card (views/card.ts) when the shown level is held above the raw one. */
export const HELD_TH = 'ข้อมูลล่าสุดต่ำลงแล้ว — ยังแสดงระดับเดิมไว้จนกว่าจะต่ำต่อเนื่อง 30 นาที';
export const CLEAR_TITLE_TH = 'ต่ำกว่าระดับเตือนภัยต่อเนื่อง 1 ชม. แล้ว';

export interface AlertMessage { kind: 'alert' | 'clear' | 'trend'; level: Level; title: string; body: string }

const timeLine = (gen: string) => `ข้อมูลเมื่อ ${fmtTime(gen)} · ${NO_OFFICIAL_ORDER}`;

/** "เตือน 3/4" (spec §5.4): the card's headline at the shown level, its actions and the time. */
export function alertMessage(shown: 3 | 4, a: Assessment, gen: string, joined: boolean): AlertMessage {
  const lines = [
    ...(joined ? [`ตอนนี้จุดนี้อยู่ในระดับ${LEVEL_TH[shown]}`] : []),
    headlineText({ ...a, level: shown }),
    ...(a.level < shown ? [HELD_TH] : []),
    `ควรทำ: ${actionLines(shown).join(' · ')}`,
    ...(a.confidence === 'low' ? [LOW_CONF_TH] : []),
    timeLine(gen),
  ];
  return { kind: 'alert', level: shown, title: LEVEL_TH[shown], body: lines.join('\n') };
}

/** The lines under a "เลิกเตือน" title — shared with the Telegram detail text (Plan O spec §2.3). */
export function clearLead(now: Level, quietUntil: string | null): string[] {
  return [
    `ตอนนี้: ${LEVEL_TH[now]} — น้ำอาจยังไม่ลด ดูสภาพจริงและประกาศของอำเภอ/เขต`,
    ...(quietUntil ? [`ถ้าระดับกลับขึ้น "เตือนภัย" ก่อน ${fmtTime(quietUntil)} จะไม่แจ้งซ้ำ (ยกเว้นขึ้นถึง "อันตราย") — เปิดเว็บดูเป็นระยะ`] : []),
  ];
}

/** The lines under a trend title, without the rate and without actions (Plan O spec §2.3). */
export function trendLead(kind: TrendKind, shown: Level): string[] {
  if (kind === 'trend_fall') return [`ยังอยู่ในระดับ${LEVEL_TH[shown]} — อย่าเพิ่งลุยน้ำหรือขับผ่าน ระวังไฟฟ้าและท่อระบายน้ำ`, 'จะแจ้งอีกครั้งถ้าน้ำกลับขึ้น'];
  if (kind === 'trend_rise') return ['ยังไม่ควรกลับเข้าพื้นที่น้ำท่วม'];
  return ['ยังไม่ถึงระดับเตือนภัย — เตรียมย้ายรถและยกของขึ้นที่สูง ติดตามทุก 1 ชม.'];
}

/** "เลิกเตือน" (spec §5.4): below 3 for an hour — never "safe", never "the water went down". */
export function clearMessage(now: 1 | 2, gen: string, quietUntil: string | null): AlertMessage {
  const lines = [...clearLead(now, quietUntil), timeLine(gen)];
  return { kind: 'clear', level: now, title: CLEAR_TITLE_TH, body: lines.join('\n') };
}

export const TREND_TITLE_TH: Record<TrendKind, string> = {
  trend_fall: 'น้ำใกล้จุดนี้เริ่มลด',
  trend_rise: 'น้ำใกล้จุดนี้กลับขึ้นอีก',
  trend_fast: 'น้ำใกล้จุดนี้ขึ้นเร็ว',
};

/** Trend alerts (spec §2.3): no emoji; never "the water went down", only "starting to fall". */
export function trendMessage(kind: TrendKind, t: Trend, shown: Level, gen: string): AlertMessage {
  const where = t.name !== undefined && t.km !== undefined ? ` · ${t.name} ${distanceText(t.km)}` : '';
  const rate = Math.abs(t.cmPerH ?? 0);
  const first = kind === 'trend_fall' ? `กำลังลด −${rate} ซม./ชม.${where}` : `กำลังขึ้น +${rate} ซม./ชม.${where}`;
  const mid = kind === 'trend_rise' ? [...trendLead(kind, shown), `ควรทำ: ${actionLines(shown).join(' · ')}`] : trendLead(kind, shown);
  return { kind: 'trend', level: shown, title: TREND_TITLE_TH[kind], body: [first, ...mid, timeLine(gen)].join('\n') };
}

/** The Web Push payload (spec §5.4): no place name — the service worker adds it from the device. */
export function pushPayload(m: AlertMessage, key: string, gen: string): string {
  // Service workers already installed drop an unknown `t` to a generic notification, so a trend
  // goes out as t:'alert' plus x:'trend'; the new worker reads x and does not re-alert or pin it.
  const head = m.kind === 'trend' ? { t: 'alert', x: 'trend' } : { t: m.kind };
  return JSON.stringify({ v: 1, ...head, k: key, l: m.level, title: m.title, body: m.body, at: gen });
}

/** Words no alert text may contain (spec §1); "ปลอดภัย" only inside "ไม่ได้แปลว่าปลอดภัย". */
export function honestyViolations(text: string): string[] {
  const out: string[] = [];
  if (text.split('ไม่ได้แปลว่าปลอดภัย').join('').includes('ปลอดภัย')) out.push('ปลอดภัย');
  for (const w of ['อพยพ', 'หมดห่วง', 'น้ำลดแล้ว']) if (text.includes(w)) out.push(w);
  return out;
}
