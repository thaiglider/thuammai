import { actionLines, headlineText, NO_OFFICIAL_ORDER } from './advice';
import { LEVEL_TH } from './labels';
import type { Assessment } from './risk';
import { fmtTime } from './time';
import type { Level } from './types';

export const ALERT_TEXT_MAX = 500;
export const PUSH_PAYLOAD_MAX_BYTES = 1500;
export const LOW_CONF_TH = 'ความมั่นใจต่ำ — ดูสภาพจริงรอบบ้าน';
/** Same sentence as the card (views/card.ts) when the shown level is held above the raw one. */
export const HELD_TH = 'ข้อมูลล่าสุดต่ำลงแล้ว — ยังแสดงระดับเดิมไว้จนกว่าจะต่ำต่อเนื่อง 30 นาที';
export const CLEAR_TITLE_TH = 'ต่ำกว่าระดับเตือนภัยต่อเนื่อง 1 ชม. แล้ว';

export interface AlertMessage { kind: 'alert' | 'clear'; level: Level; title: string; body: string }

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

/** "เลิกเตือน" (spec §5.4): below 3 for an hour — never "safe", never "the water went down". */
export function clearMessage(now: 1 | 2, gen: string, quietUntil: string | null): AlertMessage {
  const lines = [
    `ตอนนี้: ${LEVEL_TH[now]} — น้ำอาจยังไม่ลด ดูสภาพจริงและประกาศของอำเภอ/เขต`,
    ...(quietUntil ? [`ถ้าระดับกลับขึ้น "เตือนภัย" ก่อน ${fmtTime(quietUntil)} จะไม่แจ้งซ้ำ (ยกเว้นขึ้นถึง "อันตราย") — เปิดเว็บดูเป็นระยะ`] : []),
    timeLine(gen),
  ];
  return { kind: 'clear', level: now, title: CLEAR_TITLE_TH, body: lines.join('\n') };
}

/** The Web Push payload (spec §5.4): no place name — the service worker adds it from the device. */
export function pushPayload(m: AlertMessage, key: string, gen: string): string {
  return JSON.stringify({ v: 1, t: m.kind, k: key, l: m.level, title: m.title, body: m.body, at: gen });
}

/** Words no alert text may contain (spec §1); "ปลอดภัย" only inside "ไม่ได้แปลว่าปลอดภัย". */
export function honestyViolations(text: string): string[] {
  const out: string[] = [];
  if (text.split('ไม่ได้แปลว่าปลอดภัย').join('').includes('ปลอดภัย')) out.push('ปลอดภัย');
  for (const w of ['อพยพ', 'หมดห่วง', 'น้ำลดแล้ว']) if (text.includes(w)) out.push(w);
  return out;
}
