import { distanceText } from './advice';
import { KIND_TH } from './labels';
import type { WeekFile } from './week';
import { dayLabel, refLines, segments, summaryLine, yDomain } from './week-chart';

/** The web chart's geometry (views/week.ts) and its light palette (styles.css) — one image must
 *  read in both Telegram themes, so the background is always white (Plan O spec §3.1). */
export const CHART = {
  W: 320, H: 160, PAD: { l: 44, r: 8, t: 8, b: 22 }, font: 'Noto Sans Thai Looped',
  bg: '#ffffff', line: '#1d4ed8', grid: '#d1d5db', muted: '#4b5563', fg: '#111827',
} as const;
export const CAPTION_MAX = 1024;
const DAY = 86400e3;
/** A week of data plus a late "now"; a stale file drawn long after never stretches the axis or the loop. */
const MAX_SPAN_DAYS = 16;
const BKK = 7 * 3600e3;
const n = (x: number): string => x.toFixed(1);

/** The 7-day chart as a stand-alone SVG, or null when the file holds no value. Every text in it
 *  is ours (labels, dates, numbers) — the station name goes in the caption, never in the SVG. */
export function weekSvg(f: WeekFile, nowMs: number): string | null {
  if (!f.v.some((v) => v !== null)) return null;
  const { W, H, PAD } = CHART;
  const refs = refLines(f);
  const [lo, hi] = yDomain(f, refs);
  const x0 = f.t0 * 1000;
  const x1 = Math.min(Math.max(nowMs, x0 + (f.v.length - 1) * f.step * 1000), x0 + MAX_SPAN_DAYS * DAY);
  const sx = (t: number) => PAD.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - PAD.l - PAD.r);
  const sy = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const text = (x: number, y: number, s: string, anchor: 'start' | 'end' = 'start') =>
    `<text x="${n(x)}" y="${n(y)}" font-size="10" text-anchor="${anchor}" fill="${CHART.muted}">${s}</text>`;
  const vline = (x: number, stroke: string) => `<line x1="${n(x)}" x2="${n(x)}" y1="${PAD.t}" y2="${H - PAD.b}" stroke="${stroke}" stroke-width="1"/>`;
  const out: string[] = [];
  // day gridlines + labels (Bangkok midnight)
  for (let t = Math.ceil((x0 + BKK) / DAY) * DAY - BKK; t <= x1; t += DAY) out.push(vline(sx(t), CHART.grid), text(sx(t) + 2, H - 6, dayLabel(t)));
  for (const v of [lo, hi]) out.push(text(PAD.l - 4, sy(v) + 4, f.kind === 'road' ? `${Math.round(v)}` : v.toFixed(2), 'end'));
  for (const r of refs) {
    out.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${n(sy(r.v))}" y2="${n(sy(r.v))}" stroke="${CHART.muted}" stroke-width="1" stroke-dasharray="4 3"/>`, text(PAD.l + 2, sy(r.v) - 3, r.label));
  }
  for (const seg of segments(f)) {
    out.push(seg.length === 1
      ? `<circle cx="${n(sx(seg[0]!.t))}" cy="${n(sy(seg[0]!.v))}" r="3" fill="${CHART.line}"/>`
      : `<polyline points="${seg.map((p) => `${n(sx(p.t))},${n(sy(p.v))}`).join(' ')}" fill="none" stroke="${CHART.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  // "now" only when it falls inside the plot (a stale file drawn later, or a clock before the data)
  if (nowMs >= x0 && nowMs <= x1) out.push(vline(sx(nowMs), CHART.fg), text(sx(nowMs) - 3, PAD.t + 9, 'ตอนนี้', 'end'));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${CHART.font}"><rect width="${W}" height="${H}" fill="${CHART.bg}"/>${out.join('')}</svg>`;
}

/** The photo's caption (spec §3.3): whose chart it is, then the 7-day summary; cut on a code-point
 *  boundary so a long third-party station name can never make Telegram reject the photo. */
export function chartCaption(label: string | null, f: WeekFile, km: number): string {
  const s = `${label ?? 'จุดที่คุณส่งมา'} — ${f.name} · ${KIND_TH[f.kind]} · ${distanceText(km)}\n${summaryLine(f)}`;
  if (s.length <= CAPTION_MAX) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > CAPTION_MAX - 1) break;
    out += ch;
  }
  return `${out}…`;
}
