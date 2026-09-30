import type { Flag, Kind, Level } from './types';

export const LEVEL_TH: Record<Level, string> = {
  0: 'ไม่มีข้อมูล',
  1: 'ยังไม่พบสัญญาณน้ำท่วม',
  2: 'เฝ้าระวัง',
  3: 'เตือนภัย',
  4: 'อันตราย',
};

/** Background/foreground pairs; every pair meets WCAG AA (≥4.5:1) for normal text. */
export const LEVEL_COLOR: Record<Level, { bg: string; fg: string }> = {
  0: { bg: '#6b7280', fg: '#ffffff' },
  1: { bg: '#15803d', fg: '#ffffff' },
  2: { bg: '#facc15', fg: '#1f2937' },
  3: { bg: '#c2410c', fg: '#ffffff' },
  4: { bg: '#b91c1c', fg: '#ffffff' },
};

export const KIND_TH: Record<Kind, string> = { river: 'แม่น้ำ', canal: 'คลอง', road: 'ถนน', rain: 'ฝน', dam: 'เขื่อน' };

export const EMERGENCY: readonly { tel: string; th: string; bkkOnly?: boolean }[] = [
  { tel: '1669', th: 'เจ็บป่วยฉุกเฉิน' },
  { tel: '1784', th: 'ปภ. ช่วยเหลือผู้ประสบภัย' },
  { tel: '191', th: 'เหตุด่วนเหตุร้าย' },
  { tel: '199', th: 'ดับเพลิง/กู้ภัย' },
  { tel: '1555', th: 'กรุงเทพมหานคร', bkkOnly: true },
  { tel: '1146', th: 'กรมทางหลวง' },
  { tel: '1130', th: 'การไฟฟ้านครหลวง' },
  { tel: '1129', th: 'การไฟฟ้าส่วนภูมิภาค' },
];

export const DISCLAIMER_TH = 'ข้อมูลประกอบการตัดสินใจเพื่อเตรียมพร้อม ไม่ใช่ประกาศทางการ — ทำตามประกาศของอำเภอ/เขตเสมอ';
export const AREA_NOTE_TH = 'ระดับพื้นที่ = จุดที่หนักที่สุดที่ยืนยันแล้ว ไม่ใช่ทุกจุดในพื้นที่';
export const NO_DATA_NOTE_TH = 'ไม่มีข้อมูล — ไม่ได้แปลว่าปลอดภัย';

/** Level-0 place with a fresh water station within 20 km (spec 2026-10-01 §5): still grey, never "safe". */
export const NO_NEAR_TH = 'ไม่มีสถานีใกล้';
export const NO_NEAR_NOTE_TH = 'ไม่มีสถานีวัดน้ำใกล้จุดนี้ จึงประเมินไม่ได้ — ไม่ได้แปลว่าปลอดภัย';
export const NO_NEAR_FOOT_TH = 'ความมั่นใจต่ำ · ไม่ได้บอกสภาพที่จุดนี้';
/** A station's own level in the "ไม่มีสถานีใกล้" list: 1 is "ปกติ" (at the station), never the place-level wording. */
export const STATION_LEVEL_TH: Record<1 | 2 | 3 | 4, string> = { 1: 'ปกติ', 2: LEVEL_TH[2], 3: LEVEL_TH[3], 4: LEVEL_TH[4] };
/** The one label for a place's level (badge, aria-label, share text, multi-place summary). */
export function placeLevelTh(level: Level, noNear: boolean): string {
  return level === 0 && noNear ? NO_NEAR_TH : LEVEL_TH[level];
}

/** River bank notes (spec 2026-10-01 §1.3), shown only when the station is at level ≥3. */
export const BANK_SUSPECT_TH = 'ข้อมูลตลิ่งของสถานีนี้น่าสงสัย';
export const BANK_LOW_SIDE_TH = 'น้ำเกินตลิ่งฝั่งต่ำ แต่ยังต่ำกว่าตลิ่งฝั่งสูง';
/** 1 = bank_suspect, 2 = bank_low_side (the value of Reason.params.bankSuspect). */
export function bankSuspectKind(flags: readonly Flag[] | undefined): 1 | 2 | undefined {
  if (flags?.includes('bank_low_side')) return 2;
  return flags?.includes('bank_suspect') ? 1 : undefined;
}
export function bankNoteTh(kind: 1 | 2): string {
  return kind === 2 ? `${BANK_SUSPECT_TH} — ${BANK_LOW_SIDE_TH}` : BANK_SUSPECT_TH;
}
