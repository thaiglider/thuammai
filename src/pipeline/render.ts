import type { AreaLevel } from '../core/area';
import { AREA_NOTE_TH, DISCLAIMER_TH, EMERGENCY, KIND_TH, LEVEL_COLOR, LEVEL_TH, NO_DATA_NOTE_TH } from '../core/labels';
import { DISPLAY } from '../core/thresholds';
import { fmtDateTime, fmtTime } from '../core/time';
import type { Level, Observation } from '../core/types';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function stationLine(o: Observation): string {
  const parts: string[] = [`${KIND_TH[o.kind]} ${o.name}`];
  if ((o.kind === 'river' || o.kind === 'canal') && o.bank !== undefined) {
    const cm = Math.round((o.bank - o.v) * 100);
    parts.push(cm <= 0 ? `น้ำล้นตลิ่ง ${Math.abs(cm)} ซม.` : `น้ำต่ำกว่าตลิ่ง ${cm} ซม.`);
  } else if (o.kind === 'river' && o.sit === 5) {
    parts.push('ระดับน้ำสูงมาก (ตามเกณฑ์ สสน.)');
  } else if (o.kind === 'canal' && o.bmaCrit !== undefined && o.v >= o.bmaCrit) {
    parts.push('น้ำสูงเกินเกณฑ์วิกฤตของ กทม.');
  }
  if (o.kind === 'road') parts.push(o.flags?.includes('step5cm') && o.v >= 20 ? 'น้ำบนถนน 20 ซม. ขึ้นไป' : `น้ำบนถนน ${o.v} ซม.`);
  if (o.kind === 'rain') parts.push(`ฝน 24 ชม. ${o.v} มม.`);
  if (o.kind === 'dam') parts.push(`น้ำในเขื่อน ${Math.round(o.v)}% ของความจุ`);
  if (o.slope3h !== undefined && o.kind !== 'road' && o.slope3h >= DISPLAY.slopeTextMinMH) parts.push(`น้ำกำลังขึ้น ${Math.round(o.slope3h * 100)} ซม./ชม.`);
  if (o.held) parts.push(`(ค้างจาก ${fmtTime(o.held.lastFreshAt)})`);
  else parts.push(`(วัดเมื่อ ${fmtTime(o.t)})`);
  return parts.join(' · ');
}

const CSS = `
:root{--bg:#ffffff;--fg:#111827;--muted:#4b5563;--line:#e5e7eb;--card:#f9fafb;--link:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--fg:#f3f4f6;--muted:#cbd5e1;--line:#334155;--card:#111a2e;--link:#93c5fd}}
html{font-size:18px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.7 "Noto Sans Thai Looped","Noto Sans Thai",Tahoma,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}a{color:var(--link)}h1{font-size:1.5rem;margin:.2em 0}h2{font-size:1.15rem;margin:1.2em 0 .4em}
.badge{display:inline-block;padding:.25em .8em;border-radius:999px;font-weight:700;font-size:1.3rem}
.muted{color:var(--muted);font-size:1rem}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:8px 0}
ul{padding-left:1.1em}li{margin:.35em 0}.tel a{display:inline-block;min-height:44px;padding:8px 0}
main p > a{display:inline-block;min-height:44px;padding:8px 0}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding:10px 0}
.row a{min-height:44px;display:flex;align-items:center}
`;

/** Plain-text freshness warning: pages keep working (and keep looking current) even if the pipeline stops. */
const freshnessNote = (generatedAt: string) =>
  `<p class="muted"><strong>${esc(`ข้อมูล ณ ${fmtDateTime(generatedAt)} — ถ้าเวลานี้เก่ากว่า 1 ชั่วโมง ข้อมูลอาจไม่เป็นปัจจุบัน`)}</strong></p>`;

const badge = (l: Level) => `<span class="badge" style="background:${LEVEL_COLOR[l].bg};color:${LEVEL_COLOR[l].fg}">${esc(LEVEL_TH[l])}</span>`;

function emergency(bkk: boolean): string {
  const items = EMERGENCY.filter((e) => bkk || !e.bkkOnly)
    .map((e) => `<li class="tel"><a href="tel:${e.tel}">โทร ${e.tel}</a> — ${esc(e.th)}</li>`).join('');
  return `<h2>โทรฉุกเฉิน</h2><ul>${items}</ul>`;
}

function shell(title: string, ogDesc: string, body: string, canonical = ''): string {
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="600">
<title>${esc(title)}</title>
${canonical ? `<link rel="canonical" href="${esc(canonical)}">
` : ''}<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(ogDesc)}">
<style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export interface UpstreamRow { code: string; th: string; v: number | null; bank: number | null; q: number | null; level: Level; t: string | null; qThresholds?: number[] }
export interface AreaPage {
  code: string; kind: 'province' | 'district'; name: string; parentName?: string; lat: number; lon: number;
  area: AreaLevel; obs: Observation[]; dams: Observation[]; upstream?: UpstreamRow[];
}

/** `publicOrigin` (e.g. https://flood.thaiglider.com, already validated) enables the canonical link; empty = none. */
export function renderAreaPage(p: AreaPage, generatedAt: string, publicOrigin = ''): string {
  const L = p.area.level;
  const label = p.kind === 'district' ? `เขต${p.name} กรุงเทพมหานคร` : p.name;
  const title = `${label}: ${LEVEL_TH[L]} · ${fmtTime(generatedAt)}`;
  const flagged = p.obs.filter((o) => o.level >= 2 && o.kind !== 'rain').sort((a, b) => b.level - a.level);
  const rain = p.obs.filter((o) => o.kind === 'rain' && o.level >= 2);
  const list = (arr: Observation[]) => `<ul>${arr.map((o) => `<li>${badge(o.level)} ${esc(stationLine(o))}</li>`).join('')}</ul>`;
  const bkk = p.code === '10' || p.kind === 'district';
  let body = `<p><a href="index.html">← ทุกพื้นที่</a></p>
<h1>${esc(label)}</h1>
<p>${badge(L)}</p>
${freshnessNote(generatedAt)}`;
  if (L === 0) body += `<p><strong>${esc(NO_DATA_NOTE_TH)}</strong> — ไม่มีสถานีวัดระดับน้ำที่ส่งข้อมูลล่าสุดในพื้นที่นี้</p>`;
  else body += `<p>สถานีระดับเฝ้าระวังขึ้นไป <strong>${p.area.n2} จาก ${p.area.N} สถานี</strong> (เตือนภัยขึ้นไป ${p.area.n3} จาก ${p.area.N} สถานี)</p>`;
  body += `<p class="muted">${esc(AREA_NOTE_TH)}</p>
<p class="muted">อัปเดต ${esc(fmtDateTime(generatedAt))}</p>
<p><a href="../?lat=${p.lat}&amp;lon=${p.lon}">ดูความเสี่ยงที่บ้านของฉัน</a></p>`;
  if (flagged.length) body += `<h2>จุดที่ควรติดตาม</h2>${list(flagged)}`;
  if (rain.length) body += `<h2>ฝนหนัก</h2>${list(rain)}`;
  if (p.dams.length) body += `<h2>เขื่อนในจังหวัด</h2>${list(p.dams)}`;
  if (p.upstream?.length) {
    body += `<h2>สายน้ำเจ้าพระยา (เหนือ → ใต้)</h2><ul>${p.upstream.map((u) => {
      const bits = [esc(u.th)];
      if (u.v !== null && u.bank !== null) {
        const cm = Math.round((u.bank - u.v) * 100);
        bits.push(cm <= 0 ? `ล้นตลิ่ง ${Math.abs(cm)} ซม.` : `ต่ำกว่าตลิ่ง ${cm} ซม.`);
      }
      if (u.q !== null) bits.push(`ไหล ${Math.round(u.q).toLocaleString('en-US')} ลบ.ม./วินาที`);
      if (u.t) bits.push(`(${fmtTime(u.t)})`);
      return `<li>${badge(u.level)} ${bits.join(' · ')}</li>`;
    }).join('')}</ul>`;
  }
  body += emergency(bkk);
  body += `<p class="muted">${esc(DISCLAIMER_TH)}</p>
<p class="muted">ข้อมูล: สสน. (ThaiWater), Longdo Traffic, Traffy Fondue, Open-Meteo, กรมอุตุนิยมวิทยา · ขอบเขตการปกครอง: OCHA COD-AB (CC BY-IGO)</p>`;
  const og = L === 0 ? NO_DATA_NOTE_TH : `${p.area.n2} จาก ${p.area.N} สถานีอยู่ในระดับเฝ้าระวังขึ้นไป · อัปเดต ${fmtTime(generatedAt)}`;
  return shell(title, og, body, publicOrigin ? `${publicOrigin}/p/${p.code}.html` : '');
}

export interface IndexRow { code: string; kind: 'province' | 'district'; name: string; level: Level; N: number; n2: number }

export function renderIndex(rows: IndexRow[], generatedAt: string, publicOrigin = ''): string {
  const sorted = [...rows].sort((a, b) => b.level - a.level || b.n2 / Math.max(1, b.N) - a.n2 / Math.max(1, a.N) || a.name.localeCompare(b.name, 'th'));
  const row = (r: IndexRow) => `<div class="row"><a href="${esc(r.code)}.html">${esc(r.kind === 'district' ? `เขต${r.name}` : r.name)}</a>${badge(r.level)}</div>`;
  const worrying = sorted.filter((r) => r.level >= 2 && r.kind === 'province').slice(0, 5);
  const body = `<h1>ท่วมไหม</h1>
<p><a href="../">เปิดแอป "จุดของฉัน"</a></p>
<p>ประเมินความเสี่ยงน้ำท่วมจากข้อมูลเปิด อัปเดต ${esc(fmtDateTime(generatedAt))}</p>
${freshnessNote(generatedAt)}
${worrying.length ? `<h2>จังหวัดที่น่าห่วงตอนนี้</h2><div class="card">${worrying.map(row).join('')}</div>` : ''}
<h2>ทุกจังหวัด</h2>${sorted.filter((r) => r.kind === 'province').map(row).join('')}
<h2>เขตในกรุงเทพมหานคร</h2>${sorted.filter((r) => r.kind === 'district').map(row).join('')}
${emergency(true)}
<p class="muted">${esc(DISCLAIMER_TH)}</p>`;
  return shell('ท่วมไหม — ความเสี่ยงน้ำท่วมรายพื้นที่', `อัปเดต ${fmtTime(generatedAt)}`, body, publicOrigin ? `${publicOrigin}/p/index.html` : '');
}
