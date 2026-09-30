import { distanceText } from '../../core/advice';
import { bankNoteTh, placeLevelTh } from '../../core/labels';
import type { Reason } from '../../core/risk';
import type { Level, Observation } from '../../core/types';
import { fmtTime } from '../../core/time';
import { relativeAge } from './freshness';

export { distanceText };

export function sourceLabel(r: Reason): string {
  if (r.kind === 'forecast') return 'Open-Meteo';
  if (r.kind === 'traffy') return 'ประชาชนแจ้งผ่าน Traffy (ยังไม่ยืนยัน)';
  if (r.kind === 'longdo') {
    if (r.reporter === 'highway') return 'กรมทางหลวง (ทางการ)';
    if (r.reporter === 'itic') return 'เจ้าหน้าที่ iTIC';
    return 'ประชาชนแจ้งผ่าน Longdo (ยังไม่ยืนยัน)';
  }
  return 'สสน. (ThaiWater)';
}

function what(r: Reason): string {
  const p = r.params;
  const parts: string[] = [];
  if (r.kind === 'canal' || r.kind === 'river') {
    if (typeof p.freeboardCm === 'number') parts.push(p.freeboardCm > 0 ? `น้ำต่ำกว่าตลิ่ง ${p.freeboardCm} ซม.` : `น้ำล้นตลิ่ง ${Math.abs(p.freeboardCm)} ซม.`);
    if (p.overBmaCrit) parts.push('น้ำสูงเกินเกณฑ์วิกฤตของ กทม.');
    if (typeof p.slopeCmH === 'number' && p.slopeCmH > 0) parts.push(`น้ำกำลังขึ้น ${p.slopeCmH} ซม./ชม.`);
    if (r.far) parts.push('สถานีอยู่ไกล ใช้ประกอบเท่านั้น');
  } else if (r.kind === 'road') {
    parts.push(p.atLeast ? `น้ำบนถนน ${p.depthCm} ซม. ขึ้นไป` : `น้ำบนถนน ${p.depthCm} ซม.`);
  } else if (r.kind === 'rain') {
    if (typeof p.r1h === 'number') parts.push(`ฝน 1 ชม. ${p.r1h} มม.`);
    if (typeof p.r3h === 'number') parts.push(`ฝน 3 ชม. ${p.r3h} มม.`);
    parts.push(`ฝน 24 ชม. ${p.mm24} มม.`);
  } else if (r.kind === 'forecast') {
    parts.push(`คาดว่าฝนจะตก ${p.mm3} มม. ใน 3 ชม. (${p.mm6} มม. ใน 6 ชม.)`);
  } else {
    const depth = typeof p.depthCm === 'number' ? ` ลึกราว ${p.depthCm} ซม.` : '';
    const who = r.kind === 'traffy' || r.reporter === 'public' ? `ประชาชนแจ้ง ${p.count} เรื่อง` : 'มีรายงานน้ำท่วม';
    parts.push(`${who}${depth}`);
    if (p.impassable) parts.push('ผ่านไม่ได้');
  }
  return parts.join(' · ');
}

export function reasonLine(r: Reason, now: Date): string {
  const head = r.name ? `${r.name}: ` : '';
  const when = r.held ? `(ค้างจาก ${fmtTime(r.at)})` : `วัดเมื่อ ${relativeAge(r.at, now)} (${fmtTime(r.at)})`;
  const b = r.params.bankSuspect;
  const note = b === 1 || b === 2 ? ` · ${bankNoteTh(b)}` : '';
  return `${head}${what(r)}${note} · ห่าง ${distanceText(r.km)} · ${when} · ${sourceLabel(r)}`;
}

/** Caption for sharing one place; the link follows it ("… ดูล่าสุด: <ลิงก์>", spec §9.2). */
export function shareCaption(name: string, level: Level, generatedAt: string, noNear = false): string {
  return `${name}: ${placeLevelTh(level, noNear)} (ณ ${fmtTime(generatedAt)}) ดูล่าสุด:`;
}

export function shareText(name: string, level: Level, generatedAt: string, url: string): string {
  return `${shareCaption(name, level, generatedAt)} ${url}`;
}

/** Plain-Thai value of a station reading (no metres above sea level, no station codes). */
export function obsValueText(o: Observation): string | null {
  switch (o.kind) {
    case 'river':
    case 'canal': {
      if (o.bank === undefined) return null;
      const cm = Math.round((o.bank - o.v) * 100);
      if (cm > 0) return `น้ำต่ำกว่าตลิ่ง ${cm} ซม.`;
      return cm === 0 ? 'น้ำเสมอตลิ่ง' : `น้ำล้นตลิ่ง ${-cm} ซม.`;
    }
    case 'road':
      return o.flags?.includes('step5cm') && o.v >= 20 ? `น้ำบนถนน ${o.v} ซม. ขึ้นไป` : `น้ำบนถนน ${o.v} ซม.`;
    case 'rain':
      return `ฝน 24 ชม. ${o.v} มม.`;
    case 'dam':
      return `น้ำในเขื่อน ${Math.round(o.v)}% ของความจุ`;
  }
}
