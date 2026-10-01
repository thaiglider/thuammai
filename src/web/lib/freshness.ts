import { relativeAge } from '../../core/reason-text';
import { fmtTime } from '../../core/time';

export { relativeAge };

export type FreshState = 'fresh' | 'late' | 'veryLate' | 'offline';
const MIN = 60e3;

/** Device time, unless it is before the snapshot or more than 24 h after it — then the server's Date header. */
export function effectiveNow(device: Date, serverDate: string | null, generatedAt: string): Date {
  const age = device.getTime() - Date.parse(generatedAt);
  if (age >= 0 && age <= 24 * 60 * MIN) return device;
  const s = serverDate ? Date.parse(serverDate) : NaN;
  return Number.isNaN(s) ? device : new Date(s);
}

export function freshness(generatedAt: string, now: Date, online: boolean) {
  const ageMin = Math.max(0, Math.round((now.getTime() - Date.parse(generatedAt)) / MIN));
  const grey = !online || ageMin > 180;
  if (!online) return { state: 'offline' as FreshState, ageMin, grey, text: `ออฟไลน์ — แสดงข้อมูลเมื่อ ${fmtTime(generatedAt)}` };
  if (ageMin <= 20) return { state: 'fresh' as FreshState, ageMin, grey, text: `อัปเดต ${fmtTime(generatedAt)}` };
  if (ageMin <= 60) return { state: 'late' as FreshState, ageMin, grey, text: `ข้อมูลช้า ${ageMin} นาที` };
  const hh = Math.floor(ageMin / 60);
  const mm = ageMin % 60;
  return { state: 'veryLate' as FreshState, ageMin, grey, text: `ข้อมูลช้า ${hh} ชม.${mm ? ` ${mm} นาที` : ''}` };
}

/** Shown next to anything greyed because the snapshot is old or the device is offline. */
export function staleLine(generatedAt: string, now: Date): string {
  return `ข้อมูลเมื่อ ${fmtTime(generatedAt)} (${relativeAge(generatedAt, now)}) อาจไม่ตรงกับตอนนี้`;
}
