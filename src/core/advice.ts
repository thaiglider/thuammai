import { fmtTime } from './time';
import type { Assessment } from './risk';
import type { Access, Area, Pass } from './access';
import type { Situation } from './situation';
import type { Vehicle } from './thresholds';
import { trendCandidates, type Trend } from './trend';
import type { Level, Observation } from './types';

export const NO_OFFICIAL_ORDER = 'ข้อมูลประกอบการตัดสินใจ ไม่ใช่ประกาศทางการ';

export function distanceText(km: number): string {
  const m = Math.round(km * 100) * 10;
  if (m < 1000) return `${m} ม.`;
  return `${(Math.round(km * 10) / 10).toFixed(1)} กม.`;
}

export function situationText(s: Situation, t: Trend): string | null {
  switch (s) {
    case 'PRE_FLOOD': return t.state === 'rising' ? 'น้ำอาจมาถึง — ระดับน้ำใกล้จุดนี้กำลังขึ้น' : 'น้ำอาจมาถึง — มีสัญญาณน้ำใกล้จุดนี้';
    case 'FLOODED_RISING': return 'มีน้ำท่วม/น้ำล้นใกล้จุดนี้ — ยังขึ้นอยู่';
    case 'FLOODED_STABLE': return t.state === 'stable' ? 'มีน้ำท่วม/น้ำล้นใกล้จุดนี้ — ทรงตัว' : 'มีน้ำท่วม/น้ำล้นใกล้จุดนี้ — ยังบอกทิศทางไม่ได้';
    case 'FLOODED_FALLING': return 'น้ำใกล้จุดนี้กำลังลด';
    case 'RECOVERY': return 'น้ำลดต่ำกว่าระดับเตือนแล้ว (เคยสูงใน 24 ชม.)';
    default: return null;
  }
}

const TIDAL_NOTE = ' (มีน้ำขึ้นน้ำลงตามน้ำทะเล)';
export function trendLine(t: Trend): string | null {
  const where = t.name !== undefined && t.km !== undefined ? ` · ${t.name} ${distanceText(t.km)}` : '';
  const tidal = t.tidal ? TIDAL_NOTE : '';
  switch (t.state) {
    case 'rising': return `📈 กำลังขึ้น +${t.cmPerH} ซม./ชม.${where}${tidal}`;
    case 'falling': return `📉 กำลังลด −${Math.abs(t.cmPerH ?? 0)} ซม./ชม.${where}${tidal}`;
    case 'stable': return `ทรงตัว${where}${tidal}`;
    case 'mixed': return 'สถานีใกล้ๆ ขึ้นบ้างลงบ้าง';
    default: return null;
  }
}

/** "ทำไมน้ำยังขึ้น" — only from flags/signals we actually have (spec §7), ≤3 lines. */
export function causeLines(a: Assessment, obs: readonly Observation[]): string[] {
  const byId = new Map(obs.map((o) => [o.id, o]));
  const deciding = trendCandidates(a).map((r) => byId.get(r.stationId!)).filter((o): o is Observation => !!o);
  const out: string[] = [];
  if (deciding.some((o) => o.flags?.includes('backflow'))) out.push('แม่น้ำสูงกว่าคลอง น้ำในคลองระบายออกได้ช้า');
  if (deciding.some((o) => o.flags?.includes('tidal'))) out.push('ช่วงน้ำทะเลหนุน ระดับน้ำขึ้นลงตามรอบน้ำ');
  const rain = a.reasons.find((r) => r.family === 'rain' && r.level >= 2);
  if (rain) {
    const r3 = rain.params.r3h;
    out.push(typeof r3 === 'number'
      ? `ฝนตกหนักใกล้จุดนี้ (${Math.round(r3)} มม. ใน 3 ชม.)`
      : `ฝนตกหนักใกล้จุดนี้ (${Math.round(Number(rain.params.mm24 ?? 0))} มม. ใน 24 ชม.)`);
  }
  if (a.reasons.some((r) => r.kind === 'forecast')) out.push('คาดว่าจะมีฝนหนักใน 3–6 ชม. ข้างหน้า');
  if (a.raisedBy.includes('drainage')) out.push('ฝนหนักขณะที่คลองใกล้เต็ม');
  return out.slice(0, 3);
}

export const accessLabel = (at: 'exit' | 'near') => (at === 'exit' ? 'ทางออก' : 'ถนนใกล้จุดนี้');

export function accessLine(ac: Access): string {
  const depth = ac.depthCm === undefined ? '' : ac.atLeast ? `≥${ac.depthCm} ซม.` : `~${ac.depthCm} ซม.`;
  switch (ac.status) {
    case 'blocked': return ac.impassable ? 'ผ่านไม่ได้ (มีรายงาน)' : `ผ่านไม่ได้ — น้ำ ${depth}`;
    case 'water': return `มีน้ำ ${depth}`;
    case 'clear': {
      if (!ac.source) return 'ไม่มีน้ำ';
      const when = Number.isNaN(Date.parse(ac.source.at)) ? '' : `, ณ ${fmtTime(ac.source.at)}`;
      return `ไม่มีน้ำ (เซนเซอร์ ${ac.source.name}, ${distanceText(ac.source.km)}${when})`;
    }
    default: return ac.source?.kind === 'report' ? 'มีรายงานน้ำท่วม (ไม่ระบุความลึก)' : 'ไม่มีข้อมูลถนน';
  }
}

export function areaLine(ar: Area): string {
  switch (ar.status) {
    case 'flooding': return `พบน้ำท่วม/ล้น ${ar.flooded + ar.reports} จุด`;
    case 'watch': return `เฝ้าระวัง ${ar.watch + ar.reports} จุด`;
    case 'quiet': return 'ยังไม่พบ';
    default: return ar.incomplete ? 'ข้อมูลไม่ครบ' : 'ไม่มีสถานีหรือรายงานในรัศมี';
  }
}

export const VEHICLE_TH: Record<Vehicle, string> = { walk: 'เดิน', motorcycle: 'มอเตอร์ไซค์', car: 'รถเก๋ง', pickup: 'กระบะ/SUV' };
const VEHICLE_ICON: Record<Vehicle, string> = { walk: '🚶', motorcycle: '🏍️', car: '🚗', pickup: '🛻' };
const PASS_TH: Record<Pass, string> = { ok: 'ผ่านได้', caution: 'ระวัง', avoid: 'เลี่ยง', unknown: 'ไม่มีข้อมูล' };
export const WALK_NOTE = 'น้ำไหลแรงเพียง 15 ซม. ก็ทำให้ล้มได้ ระวังไฟรั่วและท่อระบายน้ำเปิด';

export function passLine(v: Vehicle, p: Pass, ac: Access): string {
  const depth = ac.depthCm === undefined ? '' : ` (น้ำ ${ac.atLeast ? '≥' : '~'}${ac.depthCm} ซม.)`;
  const note = v === 'walk' && (p === 'caution' || p === 'avoid') ? ` — ${WALK_NOTE}` : '';
  return `${VEHICLE_ICON[v]} ${VEHICLE_TH[v]}: ${PASS_TH[p]}${p === 'unknown' ? '' : depth}${note}`;
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

export function actionLines(level: Level, s?: Situation): string[] {
  if (s === 'FLOODED_FALLING') return ['น้ำกำลังลดแต่ยังอันตราย อย่าลุยน้ำหรือขับผ่าน', 'ยังไม่ต้องย้ายของลง รอให้ลดต่อเนื่อง', 'ระวังไฟฟ้า สัตว์มีพิษ และท่อระบายน้ำเปิด'];
  if (s === 'RECOVERY') return ['ก่อนเปิดไฟในบ้านที่เคยน้ำเข้า ให้ช่างตรวจก่อน', 'ถ่ายรูปความเสียหายไว้ก่อนทำความสะอาด', 'ระวังน้ำกลับมาหากมีฝนหนักอีก'];
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
