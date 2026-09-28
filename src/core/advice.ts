import type { Assessment } from './risk';
import type { Level } from './types';

export const NO_OFFICIAL_ORDER = 'ข้อมูลประกอบการตัดสินใจ ไม่ใช่ประกาศทางการ';

export function distanceText(km: number): string {
  const m = Math.round(km * 100) * 10;
  if (m < 1000) return `${m} ม.`;
  return `${(Math.round(km * 10) / 10).toFixed(1)} กม.`;
}

export function headlineText(a: Assessment): string {
  if (a.level === 0) return 'ยังประเมินจุดนี้ไม่ได้';
  if (a.level === 1) return 'ยังไม่พบสัญญาณน้ำท่วมใกล้จุดนี้';
  switch (a.headline) {
    case 'road': return 'มีน้ำบนถนนใกล้จุดนี้แล้ว';
    case 'waterway': return 'คลอง/แม่น้ำใกล้ล้นตลิ่ง';
    case 'rain': return 'ฝนหนัก อาจมีน้ำขังในอีกไม่กี่ชั่วโมง';
    case 'forecast': return 'คาดว่าจะมีฝนหนัก';
    default: return 'มีสัญญาณน้ำท่วมใกล้จุดนี้';
  }
}

export function actionLines(level: Level): string[] {
  switch (level) {
    case 2: return ['ติดตามทุก 1–2 ชม.', 'ชาร์จโทรศัพท์', 'เตรียมยกของขึ้นที่สูง'];
    case 3: return ['ย้ายรถไปที่สูง', 'ยกของมีค่าและปลั๊กไฟขึ้นสูง', 'เตรียมยา เอกสาร ถุงกันน้ำ'];
    case 4: return ['ถ้าน้ำเริ่มเข้าบ้าน ตัดไฟที่เบรกเกอร์ ไปที่สูง', 'ทำตามประกาศของอำเภอ/เขตทันที', 'ติดอยู่ในน้ำ โทร 1784 · เจ็บป่วย โทร 1669'];
    default: return [];
  }
}

export function vehicleLine(depthCm: number | undefined): string | null {
  if (depthCm === undefined || depthCm <= 10) return null;
  if (depthCm > 30) return 'มอเตอร์ไซค์ รถเก๋ง และกระบะไม่ควรผ่าน (น้ำเกิน 30 ซม.)';
  if (depthCm > 20) return 'มอเตอร์ไซค์และรถเก๋งไม่ควรผ่าน (น้ำเกิน 20 ซม.)';
  return 'มอเตอร์ไซค์ไม่ควรผ่าน (น้ำเกิน 10 ซม.)';
}

export function confidenceLine(a: Assessment): string | null {
  if (a.level === 0) return a.incomplete ? 'ข้อมูลไม่ครบ — ไม่ได้แปลว่าปลอดภัย' : 'ไม่มีข้อมูล — ไม่ได้แปลว่าปลอดภัย';
  if (a.confidence !== 'low') return null;
  if (a.coverage.water === 'none') {
    return 'ไม่มีสถานีวัดระดับน้ำในรัศมี 10 กม. ระดับนี้คิดจากฝนหรือรายงานเท่านั้น ให้ดูสภาพจริงรอบบ้านและประกาศของอำเภอ';
  }
  if (a.coverage.water === 'far') {
    const distance = distanceText(a.coverage.nearestWaterKm ?? 0);
    return `สถานีวัดระดับน้ำที่ใกล้ที่สุดอยู่ห่าง ${distance} ระดับนี้คิดจากหลักฐานที่อยู่ไกลหรือฝน ให้ดูสภาพจริงรอบบ้านและประกาศของอำเภอ`;
  }
  return 'ความมั่นใจต่ำ — หลักฐานอยู่ไกลหรือยังไม่ยืนยัน ให้ดูสภาพจริงรอบบ้านประกอบ';
}
