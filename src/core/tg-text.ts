import { actionLines, headlineText, NO_OFFICIAL_ORDER } from './advice';
import { ALERT, CAPS } from './alert-config';
import { HELD_TH, LOW_CONF_TH, type AlertMessage } from './alert-text';
import { LEVEL_TH } from './labels';
import type { Assessment } from './risk';
import { cleanText } from './text';
import { fmtTime } from './time';
import type { Level } from './types';

/** callback_data formats (spec §7.3, ruling 2). */
export const CB = {
  follow: /^f:(\d{1,2}\.\d{3},\d{2,3}\.\d{3})$/,
  unfollow: /^u:(\d{1,12})$/,
  stopAll: /^x:all$/,
  dismiss: /^no$/,
} as const;

export const NOT_A_REPORT_TH = 'บอทนี้ไม่รับแจ้งเหตุ — เหตุฉุกเฉินโทร 1784 / 1669 / 191';
export const START_TH = `ส่งตำแหน่งมาเพื่อดูความเสี่ยงน้ำท่วมและรับแจ้งเตือนเมื่อถึงระดับ 'เตือนภัย' · ${NOT_A_REPORT_TH}\n${NO_OFFICIAL_ORDER}`;
export const SEND_LOCATION_TH = 'ส่งตำแหน่ง';
export const OTHER_TH = `ส่งตำแหน่งมาเพื่อดูความเสี่ยงน้ำท่วม หรือพิมพ์ /help · ${NOT_A_REPORT_TH}`;
export const OUTSIDE_TH = 'ตำแหน่งนี้อยู่นอกประเทศไทย';
export const FOLLOW_BUTTON_TH = 'ติดตามจุดนี้';
export const DISMISS_BUTTON_TH = 'ไม่ต้อง';
export const STOP_ALL_BUTTON_TH = 'ลบทั้งหมด';
export const CANCEL_BUTTON_TH = 'ยกเลิก';
export const ALREADY_TH = 'ติดตามจุดนี้อยู่แล้ว';
export const MAX_FOLLOWS_TH = `ติดตามครบ ${CAPS.placesPerTarget} จุดแล้ว — ใช้ /list เพื่อเลิกบางจุด`;
/** Per-chat daily cap on NEW follows (security review: a follow/unfollow loop must not write
 *  unbounded rows) — reuses CAPS.newPlacesPerTargetPerDay, the same cap push.ts's per-target churn
 *  throttle already uses. */
export const NEW_FOLLOWS_CAP_TH = `ติดตามจุดใหม่ได้วันละไม่เกิน ${CAPS.newPlacesPerTargetPerDay} จุด — ลองใหม่พรุ่งนี้`;
export const NO_FOLLOWS_TH = 'ยังไม่ได้ติดตามจุดใด — ส่งตำแหน่งมาได้เลย';
export const NOT_FOUND_TH = 'ไม่พบจุดนี้ (อาจเลิกติดตามไปแล้ว)';
export const STOP_CONFIRM_TH = 'ลบจุดที่ติดตามและข้อมูลทั้งหมดของคุณในบอทนี้?';
export const STOPPED_TH = 'ลบข้อมูลทั้งหมดของคุณแล้ว จะไม่ได้รับแจ้งเตือนอีก ส่งตำแหน่งมาใหม่ได้ทุกเมื่อ';

/** Minutes as the bot says them: whole hours as "N ชม.", otherwise "N นาที". */
const minutesTh = (min: number): string => (min % 60 === 0 ? `${min / 60} ชม.` : `${min} นาที`);

export function helpText(siteUrl: string): string {
  return [
    `วิธีใช้: แตะ "ส่งตำแหน่ง" หรือแนบตำแหน่ง → ดูระดับ → แตะ "ติดตามจุดนี้" (ได้ไม่เกิน ${CAPS.placesPerTarget} จุด)`,
    `แจ้งเตือนเมื่อจุดที่ติดตามถึงระดับ "${LEVEL_TH[ALERT.level as Level]}" ขึ้นไป · แจ้งอีกครั้งเมื่อต่ำกว่านั้นต่อเนื่อง ${minutesTh(ALERT.clearHoldMin)} · ระดับ${LEVEL_TH[ALERT.level as Level]}ไม่แจ้งซ้ำภายใน ${minutesTh(ALERT.repeatH * 60)} ยกเว้นขึ้นถึง "${LEVEL_TH[4]}"`,
    'ข้อมูลหาย = บอทเงียบ ไม่ได้แปลว่าปลอดภัย',
    'เก็บอะไร: chat id, พิกัดโดยประมาณ (~100 ม.) และชื่อจุดที่คุณตั้ง บนเซิร์ฟเวอร์ของโครงการ (ต่างประเทศ) — ลบทั้งหมดได้ด้วย /stop (สำเนาสำรองลบภายใน 14 วัน)',
    '/list จุดที่ติดตาม · /stop เลิกทั้งหมดและลบข้อมูล',
    NOT_A_REPORT_TH,
    `ดูบนเว็บ: ${siteUrl}`,
    NO_OFFICIAL_ORDER,
  ].join('\n');
}
export const dbDownText = (siteUrl: string): string => `ระบบแจ้งเตือนขัดข้องชั่วคราว ลองใหม่ภายหลัง · ดูบนเว็บ: ${siteUrl}`;
export const fullSystemText = (siteUrl: string): string => `ระบบแจ้งเตือนรับผู้ใช้เต็มชั่วคราว ดูบนเว็บ: ${siteUrl}`;
/** ALERTS_PAUSED=1 on the server (spec §8.2, R16/R28): the answer to everything except deleting and listing. */
export const pausedText = (siteUrl: string): string => `ระบบแจ้งเตือนหยุดชั่วคราว — ดูบนเว็บ: ${siteUrl}\n${NOT_A_REPORT_TH}`;
/** Stage-1 line while the sender is stalled: no question is queued, so nothing is promised. */
export const STALLED_LINE_TH = 'ระบบแจ้งเตือนขัดข้องชั่วคราว — ระดับของจุดนี้ดูบนเว็บได้ทันที';

/** The card for a rounded point (the web offers to add it). */
export function siteLink(siteUrl: string, key: string): string {
  const [lat, lon] = key.split(',');
  return `${siteUrl}?lat=${lat}&lon=${lon}`;
}
export const provinceTitle = (code: string, th: string): string => (code === '10' ? th : `จ.${th}`);

export interface Stage1 {
  area: { name: string; level: Level; at: string; stale: boolean } | null;
  pending: 'added' | 'full' | 'stalled';
  link: string;
}
/** Immediate reply to a location (spec §7.2 step 1): the province overview, honestly labelled. */
export function stage1Text(o: Stage1): string {
  const lines: string[] = [];
  if (o.area) {
    const lvl = `${LEVEL_TH[o.area.level]}${o.area.level === 0 ? ' — ไม่ได้แปลว่าปลอดภัย' : ''}`;
    lines.push(`ภาพรวม ${o.area.name}: ${lvl} (ณ ${fmtTime(o.area.at)}) — เป็นระดับของทั้งจังหวัด ไม่ใช่ของจุดนี้`);
    if (o.area.stale) lines.push(`ข้อมูลเมื่อ ${fmtTime(o.area.at)} อาจไม่ตรงกับตอนนี้`);
  } else {
    lines.push('รับตำแหน่งแล้ว');
  }
  lines.push(o.pending === 'added'
    ? 'ระดับของจุดนี้จะส่งตามมาภายในไม่กี่นาที'
    : o.pending === 'stalled'
      ? STALLED_LINE_TH
      : `มีคำถามรอคำตอบครบ ${CAPS.tgPendingPerChat} จุดแล้ว — ระดับของจุดนี้ดูบนเว็บได้ทันที`);
  lines.push(`ดูทันทีบนเว็บ: ${o.link}`, NO_OFFICIAL_ORDER);
  return lines.join('\n');
}

export const followedText = (label: string): string =>
  `ติดตามแล้ว ตั้งชื่อจุดนี้ได้ (≤${CAPS.tgLabelMax} ตัวอักษร เช่น บ้าน) — ไม่ต้องใส่ที่อยู่ · พิมพ์ /skip เพื่อใช้ชื่อ '${label}'`;
/** Also says the bot takes no reports: a name typed during a flood may really be a cry for help (final review I2). */
export const labelSetText = (label: string): string => `ตั้งชื่อ '${label}' แล้ว\n${NOT_A_REPORT_TH}`;
export const skipText = (label: string): string => `ใช้ชื่อ '${label}'`;
export const unfollowButtonText = (label: string): string => `เลิกติดตาม ${label}`;
export const unfollowedText = (label: string): string => `เลิกติดตาม '${label}' แล้ว`;

export function listText(rows: readonly { label: string; key: string }[]): string {
  return ['จุดที่ติดตาม:', ...rows.map((r, i) => `${i + 1}. ${r.label} (${r.key.replace(',', ', ')})`)].join('\n');
}

/** A label typed to the bot (spec §8): web cleaning rules, ≤20 code points; null when nothing is left. */
export function tgLabel(text: string): string | null {
  return cleanText(text, CAPS.tgLabelMax) || null;
}

/** A name typed while the bot waits for one: cleaned like `tgLabel`, but text longer than
 *  CAPS.tgLabelMax is not a name (never cut down to one) — null, and the caller gives the normal
 *  help reply with the emergency numbers instead (final review I2). */
export function tgName(text: string): string | null {
  const full = cleanText(text, Number.POSITIVE_INFINITY);
  return full && [...full].length <= CAPS.tgLabelMax ? full : null;
}

/** "จุดที่ N" with the smallest N not used yet (ruling 5). */
export function defaultLabel(used: readonly string[]): string {
  for (let n = 1; n <= CAPS.placesPerTarget; n++) if (!used.includes(`จุดที่ ${n}`)) return `จุดที่ ${n}`;
  return `จุดที่ ${used.length + 1}`;
}

/** The follow-up answer with the point's own level (spec §7.2 step 2). */
export function pointReplyText(o: { shown: Level; a: Assessment; gen: string } | { unusable: true; gen: string | null }, link: string): string {
  if ('unusable' in o) {
    return [
      o.gen ? `ข้อมูลล่าสุดเมื่อ ${fmtTime(o.gen)} ไม่สดพอจะประเมินจุดนี้ — ไม่ได้แปลว่าปลอดภัย` : 'ยังประเมินจุดนี้ไม่ได้ตอนนี้ — ไม่ได้แปลว่าปลอดภัย',
      `ดูบนเว็บ: ${link}`,
      NO_OFFICIAL_ORDER,
    ].join('\n');
  }
  const lines = [`ระดับของจุดที่คุณส่งมา: ${LEVEL_TH[o.shown]}`];
  if (o.shown === 0) {
    lines.push('ไม่มีข้อมูลพอประเมินจุดนี้ — ไม่ได้แปลว่าปลอดภัย');
  } else {
    lines.push(headlineText({ ...o.a, level: o.shown }));
    if (o.a.level < o.shown) lines.push(HELD_TH);
    const acts = actionLines(o.shown);
    if (acts.length) lines.push(`ควรทำ: ${acts.join(' · ')}`);
    if (o.a.confidence === 'low') lines.push(LOW_CONF_TH);
  }
  lines.push(`ข้อมูลเมื่อ ${fmtTime(o.gen)} · ${NO_OFFICIAL_ORDER}`, `ดูรายละเอียด: ${link}`);
  return lines.join('\n');
}

/** Alert/clear in Telegram (spec §5.4): the user's label replaces the place name. */
export function tgAlertText(label: string, m: AlertMessage, link: string): string {
  return `${label}: ${m.title}\n${m.body}\nดูรายละเอียด: ${link}`;
}
