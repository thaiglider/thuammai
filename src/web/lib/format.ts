import { distanceText } from '../../core/advice';
import { placeLevelTh } from '../../core/labels';
import type { Level, Observation } from '../../core/types';
import { fmtTime } from '../../core/time';

export { distanceText };
export { reasonLine, sourceLabel } from '../../core/reason-text';

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
