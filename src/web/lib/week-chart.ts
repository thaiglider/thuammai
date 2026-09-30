import type { WeekFile } from '../../core/week';

const BKK = 7 * 3600e3;
const DOW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const pad = (n: number) => String(n).padStart(2, '0');

export function dayLabel(ms: number): string {
  const d = new Date(ms + BKK);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()}`;
}
const timeLabel = (ms: number) => { const d = new Date(ms + BKK); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const tOf = (f: WeekFile, i: number) => (f.t0 + i * f.step) * 1000;

export function refLines(f: WeekFile): { v: number; label: string }[] {
  if (f.kind === 'road') return [{ v: 10, label: '10 ซม.' }, { v: 30, label: '30 ซม.' }];
  const out: { v: number; label: string }[] = [];
  if (f.bank !== undefined) out.push({ v: f.bank, label: 'ตลิ่ง' });
  if (f.bmaCrit !== undefined) out.push({ v: f.bmaCrit, label: 'เกณฑ์ กทม.' });
  return out;
}

export function yDomain(f: WeekFile, refs: readonly { v: number }[]): [number, number] {
  const vals = [...f.v.filter((x): x is number => x !== null), ...refs.map((r) => r.v)];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (f.kind === 'road') lo = 0;
  if (hi - lo < 1e-9) { const d = f.kind === 'road' ? 5 : 0.1; lo -= d; hi += d; }
  const p = (hi - lo) * 0.05;
  return [f.kind === 'road' ? 0 : lo - p, hi + p];
}

export function segments(f: WeekFile): { t: number; v: number }[][] {
  const out: { t: number; v: number }[][] = [];
  let cur: { t: number; v: number }[] = [];
  f.v.forEach((v, i) => {
    if (v === null) { if (cur.length) out.push(cur); cur = []; return; }
    cur.push({ t: tOf(f, i), v });
  });
  if (cur.length) out.push(cur);
  return out;
}

const num = (f: WeekFile, v: number) => (f.kind === 'road' ? `${Math.round(v)} ซม.` : `${v.toFixed(2)} ม.รทก.`);

export function valueText(f: WeekFile, v: number): string {
  if (f.kind === 'road') return `ลึก ${Math.round(v)} ซม.`;
  if (f.bank === undefined) return num(f, v);
  const fb = Math.round((f.bank - v) * 100);
  return `${num(f, v)} · ${fb >= 0 ? `ต่ำกว่าตลิ่ง ${fb}` : `สูงกว่าตลิ่ง ${-fb}`} ซม.`;
}

export function coveragePct(f: WeekFile): number {
  return f.v.length ? Math.round((f.v.filter((x) => x !== null).length / f.v.length) * 100) : 0;
}

export function summaryLine(f: WeekFile): string {
  let maxI = -1;
  let lastI = -1;
  f.v.forEach((v, i) => { if (v === null) return; lastI = i; if (maxI < 0 || v > f.v[maxI]!) maxI = i; });
  if (maxI < 0) return 'ยังไม่มีข้อมูล';
  const at = tOf(f, maxI);
  return `7 วันที่ผ่านมา: สูงสุด ${num(f, f.v[maxI]!)} (${dayLabel(at)} ${timeLabel(at)}) · ล่าสุด ${num(f, f.v[lastI]!)} · มีข้อมูล ${coveragePct(f)}% ของชั่วโมง`;
}

export function dailyRows(f: WeekFile): { day: string; min: number; max: number; last: number }[] {
  const rows = new Map<string, { day: string; min: number; max: number; last: number }>();
  f.v.forEach((v, i) => {
    if (v === null) return;
    const day = dayLabel(tOf(f, i));
    const r = rows.get(day);
    if (!r) rows.set(day, { day, min: v, max: v, last: v });
    else { r.min = Math.min(r.min, v); r.max = Math.max(r.max, v); r.last = v; }
  });
  return [...rows.values()];
}
