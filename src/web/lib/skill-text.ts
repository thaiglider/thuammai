import type { LevelKey, SignalSet, SkillEvidence, SkillFile, SkillMetric, SkillWindow, Truth } from '../../core/skill';
import { CORROB, EVAL } from '../../core/thresholds';
import { fmtDay } from '../../core/time';

export const TRUTH_TH: Record<Truth, string> = {
  reports: 'เทียบกับรายงานน้ำท่วมจากเจ้าหน้าที่และประชาชน (Longdo, Traffy)',
  road: `เทียบกับเซนเซอร์น้ำบนถนน (น้ำสูง 10 ซม. ขึ้นไปนาน 1 ชม. ขึ้นไป — ตอนประเมินไม่ใช้ค่าของเซนเซอร์ตัวนั้นเอง และเซนเซอร์ถนนที่อยู่ห่างไม่เกิน ${CORROB.independentKm * 1000} ม.)`,
};
// 'all' is every instrument together, replayed WITHOUT reports and forecast (reports are the truth
// being scored) — it is not the full level the site shows, and must never be worded as if it were.
export const SIGNAL_TH: Record<SignalSet, string> = {
  all: 'เครื่องวัดทุกชนิดรวมกัน (เครื่องวัดเท่านั้น — ไม่รวมรายงานและพยากรณ์)',
  road: 'น้ำบนถนนอย่างเดียว', canal: 'คลองอย่างเดียว', river: 'แม่น้ำอย่างเดียว', rain: 'ฝนอย่างเดียว',
};
export const LEVEL_KEY_TH: Record<LevelKey, string> = { '3': 'ระดับเตือนภัยขึ้นไป', '2': 'ระดับเฝ้าระวังขึ้นไป' };
export type TrackState = 'pass' | 'fail' | 'insufficient';
export const TRACK_TH: Record<TrackState, string> = { pass: 'ถึงเป้า', fail: 'ยังไม่ถึงเป้า', insufficient: 'ข้อมูลยังไม่พอจะบอก' };
export const SKILL_NOTE_TH = 'ตัวเลขนี้บอกว่าที่ผ่านมาระดับที่ประเมินจากเครื่องวัดตรงกับน้ำท่วมจริงแค่ไหน ไม่ใช่คำรับประกันว่าครั้งต่อไปจะถูก'
  + ' · วัดจากเครื่องวัดเท่านั้น ไม่รวมรายงานและพยากรณ์ — ระดับที่เว็บแสดงจริงใช้รายงานและพยากรณ์ด้วย ซึ่งส่วนนั้นตัวเลขนี้ไม่ได้วัด'
  + ' · ตัวอย่างนับเป็นรายชั่วโมง รายงานหรือเซนเซอร์เดียวจึงนับได้หลายครั้ง — ดูจำนวนรายงาน/เซนเซอร์และจำนวนวันที่กำกับไว้'
  + ' · วัดเฉพาะกรุงเทพฯ และปริมณฑล · ไม่มีรายงาน ≠ ไม่ท่วม';
export const SKILL_NONE_TH = 'ยังไม่มีผลความแม่นย้อนหลัง — ระบบจะคำนวณวันละครั้ง';
export const REPORTS_PREC_NOTE_TH = 'น่าจะต่ำกว่าความจริง เพราะหลายที่ท่วมแต่ไม่มีคนรายงาน';
export const ABNORMAL_TH = 'ข้อมูลผิดปกติ';

/** The independent unit behind a hit rate (truth cases) and behind a precision (warned places). */
const HIT_UNIT_TH: Record<Truth, string> = { reports: 'รายงาน', road: 'เซนเซอร์' };
const FLAG_UNIT_TH: Record<Truth, string> = { reports: 'จุดที่เตือน', road: 'เซนเซอร์ที่เตือน' };

const pct = (x: number) => `${Math.round(x * 100)}%`;
const count = (n: number) => n.toLocaleString('en-US');

// isSkillFile only checks the JSON shape (numbers, or null), not the range — a corrupted or
// future-format file could carry e.g. hit=1.5 or nHit=-1. Such a metric is shown as "ข้อมูลผิดปกติ"
// (never an impossible number, never a count that contradicts itself).
const okRatio = (x: number | null): boolean => x === null || (Number.isFinite(x) && x >= 0 && x <= 1);
const okCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const safeRatio = (x: number | null): number | null => (x !== null && okRatio(x) ? x : null);
const safeLift = (x: number | null): number | null => (x === null || !Number.isFinite(x) || x < 0 ? null : x);

/** Why a ratio is null: too few hourly samples, or too few distinct units / days behind them. */
function notEnough(n: number, minN: number, units: number, days: number, noun: string, minUnits: number): string {
  if (n < minN) return `ข้อมูลยังไม่พอ (มี ${count(n)} ตัวอย่างรายชั่วโมง ต้องมีอย่างน้อย ${minN})`;
  if (units < minUnits || days < EVAL.minDays) {
    return `ข้อมูลยังไม่พอ (${count(n)} ตัวอย่างรายชั่วโมง มาจาก ${count(units)} ${noun} ใน ${count(days)} วัน ต้องมาจากอย่างน้อย ${minUnits} ${noun} ใน ${EVAL.minDays} วัน)`;
  }
  return 'ข้อมูลยังไม่พอ';
}

export function hitText(m: SkillMetric, minN: number, ev: SkillEvidence, truth: Truth): string {
  if (!okRatio(m.hit) || !okCount(m.nHit) || !okCount(ev?.units) || !okCount(ev?.days)) return `จับได้: ${ABNORMAL_TH}`;
  const noun = HIT_UNIT_TH[truth];
  if (m.hit === null) return `จับได้: ${notEnough(m.nHit, minN, ev.units, ev.days, noun, EVAL.minTruthUnits[truth])}`;
  return `จับได้ ${pct(m.hit)} ของครั้งที่มีน้ำท่วมจริง (${count(m.nHit)} ตัวอย่าง นับเป็นรายชั่วโมง จาก ${count(ev.units)} ${noun} ใน ${count(ev.days)} วัน)`;
}

/** Lift = precision ÷ base rate. Only a lift clearly above 1 is "better than chance". */
export function liftText(x: number | null): string {
  const lift = safeLift(x);
  if (lift === null) return '';
  if (lift >= EVAL.liftBetter) return ` · ดีกว่าการเดาสุ่ม ${lift.toFixed(1)} เท่า`;
  if (lift > EVAL.liftWorse) return ' · ไม่ดีกว่าการเดาสุ่ม (พอ ๆ กับการเดาสุ่ม)';
  return ' · ไม่ดีกว่าการเดาสุ่ม (แย่กว่าการเดาสุ่ม)';
}

export function precText(m: SkillMetric, minN: number, truth: Truth): string {
  const label = 'เมื่อเตือนแล้วตรงกับน้ำท่วมจริง';
  if (!okRatio(m.prec) || !okCount(m.nFlag) || !okCount(m.uFlag) || !okCount(m.dFlag)) return `${label}: ${ABNORMAL_TH}`;
  const noun = FLAG_UNIT_TH[truth];
  if (m.prec === null) return `${label}: ${notEnough(m.nFlag, minN, m.uFlag, m.dFlag, noun, EVAL.minFlagUnits[truth])}`;
  const under = truth === 'reports' ? ` — ${REPORTS_PREC_NOTE_TH}` : '';
  return `${label} ${pct(m.prec)} (${count(m.nFlag)} ตัวอย่าง นับเป็นรายชั่วโมง จาก ${count(m.uFlag)} ${noun} ใน ${count(m.dFlag)} วัน)${under}${liftText(m.lift)}`;
}

export function trackState(w: SkillWindow, truth: Truth, target: { level: number; precision: number; hit: number }): TrackState {
  const m = w.truths[truth].all[String(target.level) as LevelKey];
  const hit = m && safeRatio(m.hit);
  const prec = m && safeRatio(m.prec);
  if (!m || hit === null || prec === null) return 'insufficient';
  return prec >= target.precision && hit >= target.hit ? 'pass' : 'fail';
}

export function targetText(target: { level: number; precision: number; hit: number }): string {
  return `เป้าที่ติดตาม: ${LEVEL_KEY_TH[String(target.level) as LevelKey]} เตือนแล้วถูก ≥${pct(target.precision)} และจับได้ ≥${pct(target.hit)} (ใช้ติดตามคุณภาพ ไม่ได้หยุดการอัปเดตเว็บ)`;
}

export function windowText(w: SkillWindow, key: '7' | '30'): string {
  if (!w.days) return `${key} วันล่าสุด (ยังไม่มีข้อมูล)`;
  const to = w.to ? fmtDay(w.to) : null;
  return `${key} วันล่าสุด (มีข้อมูล ${w.days} วัน${to ? ` · ข้อมูลถึง ${to}` : ''})`;
}

/** Staleness follows the newest DATA day (windows['7'].to, else the 30-day one), not generatedAt:
 *  evaluate keeps writing a fresh generatedAt even when the pipeline stopped recording snapshots.
 *  Only a file with no data day at all falls back to generatedAt. */
export function staleText(s: SkillFile, now: Date): string | null {
  const to = [s.windows['7'].to, s.windows['30'].to].find((d): d is string => typeof d === 'string' && fmtDay(d) !== null);
  const since = to ? Date.parse(`${to}T00:00:00+07:00`) + 86400e3 : Date.parse(s.generatedAt);
  const days = Math.floor((now.getTime() - since) / 86400e3);
  if (!Number.isFinite(days) || days < EVAL.staleDays) return null;
  return to ? `ผลนี้ไม่ได้อัปเดตมา ${days} วัน (ข้อมูลถึง ${fmtDay(to)})` : `ผลนี้ไม่ได้อัปเดตมา ${days} วัน`;
}
