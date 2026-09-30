import type { Sample } from './rise';
import { BKK_METRO, HISTORY, RECOVERY_H } from './thresholds';
import type { FloodEvent, Level, RawObs, Reporter } from './types';

export type { Sample } from './rise';
export interface CompactEvent { id: string; t: number; lat: number; lon: number; r: Reporter }
export interface History {
  v: 1;
  series: Record<string, Sample[]>;
  lastLevel: Record<string, { level: Level; t: string }>;
  events: CompactEvent[];
  highAt?: Record<string, string>;
}

const H = 3600e3;
export const emptyHistory = (): History => ({ v: 1, series: {}, lastLevel: {}, events: [] });

export function appendSamples(h: History, obs: RawObs[]): void {
  for (const o of obs) {
    let v: number;
    if (o.kind === 'dam') continue;
    if (o.kind === 'rain') {
      if (!BKK_METRO.includes(o.prov) || o.r1h === undefined) continue;
      v = o.r1h;
    } else v = o.v;
    const t = Date.parse(o.t);
    const s = (h.series[o.id] ??= []);
    const last = s[s.length - 1];
    if (last && t <= last.t) continue;
    s.push({ t, v });
  }
}

export function appendEvents(h: History, events: FloodEvent[]): void {
  const seen = new Set(h.events.map((e) => e.id));
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    h.events.push({ id: e.id, t: Date.parse(e.t), lat: e.lat, lon: e.lon, r: e.reporter });
  }
}

export function compact(h: History, nowMs: number): void {
  const rawFrom = nowMs - HISTORY.rawH * H;
  const keepFrom = nowMs - HISTORY.keepH * H;
  const slotMs = HISTORY.slotMin * 60e3;
  for (const [id, s] of Object.entries(h.series)) {
    const out: Sample[] = [];
    let lastSlot = -1;
    for (const x of s) {
      if (x.t < keepFrom) continue;
      if (x.t >= rawFrom) { out.push(x); continue; }
      const k = Math.floor(x.t / slotMs);
      if (k === lastSlot) out[out.length - 1] = x;
      else { out.push(x); lastSlot = k; }
    }
    if (out.length) h.series[id] = out;
    else delete h.series[id];
  }
  if (h.highAt) {
    const hiFrom = nowMs - RECOVERY_H * H;
    for (const [id, t] of Object.entries(h.highAt)) if (Date.parse(t) < hiFrom) delete h.highAt[id];
  }
  h.events = h.events.filter((e) => e.t >= keepFrom);
  for (const [id, l] of Object.entries(h.lastLevel)) if (Date.parse(l.t) < keepFrom) delete h.lastLevel[id];
}

export function hoursCovered(h: History, nowMs: number): number {
  let min = Infinity;
  for (const s of Object.values(h.series)) if (s.length && s[0]!.t < min) min = s[0]!.t;
  return min === Infinity ? 0 : Math.min(HISTORY.keepH, (nowMs - min) / H);
}
