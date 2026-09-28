import type { Kind, Level } from './types';

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
