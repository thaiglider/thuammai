import type { History } from '../core/history';
import { WEEK } from '../core/thresholds';
import { isWaterKind } from '../core/trend';
import type { Observation } from '../core/types';
import { weekFile, type WeekSeries, type WeekStore } from '../core/week';

const HS = 3600;
const hourOf = (ms: number) => Math.floor(ms / 3600e3) * HS; // Thailand is UTC+7 exactly: UTC hours are Thai hours
const roundFor = (kind: string, v: number) => (kind === 'road' ? Math.round(v) : Math.round(v * 100) / 100);

function put(w: WeekStore, id: string, tMs: number, v: number): void {
  const h = hourOf(tMs);
  const s = w[id];
  if (!s) { w[id] = { t0: h, v: [v] }; return; }
  const i = (h - s.t0) / HS;
  if (i < 0) return;
  while (s.v.length < i) s.v.push(null);
  s.v[i] = v;
}

/** Untrusted persisted state → a WeekStore that record/prune can never throw on; bad entries are dropped. */
export function sanitizeWeek(x: unknown): WeekStore {
  const out: WeekStore = {};
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  for (const [id, s] of Object.entries(x as Record<string, unknown>)) {
    if (!s || typeof s !== 'object') continue;
    const { t0, v } = s as { t0?: unknown; v?: unknown };
    if (!Array.isArray(v) || typeof t0 !== 'number' || !Number.isFinite(t0)) continue;
    out[id] = { t0, v: v.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : null)) } as WeekSeries;
  }
  return out;
}

/** Fresh, computed readings only: never stale, held, stuck or dropped (level 0). */
export function recordWeek(w: WeekStore, obs: readonly Observation[]): void {
  for (const o of obs) {
    if (!isWaterKind(o.kind) || o.level === 0 || o.held || o.flags?.includes('stale') || o.flags?.includes('stuck')) continue;
    const t = Date.parse(o.t);
    if (Number.isNaN(t)) continue;
    put(w, o.id, t, roundFor(o.kind, o.v));
  }
}

/** One-off start from the ≤72 h raw history the state already holds. */
export function seedWeek(w: WeekStore, history: History): void {
  for (const [id, samples] of Object.entries(history.series)) {
    const kind = id.slice(0, id.indexOf(':'));
    if (!isWaterKind(kind)) continue;
    for (const s of samples) put(w, id, s.t, roundFor(kind, s.v));
  }
}

export function pruneWeek(w: WeekStore, nowMs: number): void {
  const start = hourOf(nowMs) - (WEEK.hours - 1) * HS;
  for (const [id, s] of Object.entries(w)) {
    if (s.t0 < start) {
      const k = Math.min(s.v.length, (start - s.t0) / HS);
      s.v = s.v.slice(k);
      s.t0 = start;
    }
    let lead = 0;
    while (lead < s.v.length && s.v[lead] === null) lead++;
    if (lead) { s.v = s.v.slice(lead); s.t0 += lead * HS; }
    if (!s.v.length) delete w[id];
  }
}

export function weekOutputs(w: WeekStore, obs: readonly Observation[], head: { generatedAt: string; schema: number; thresholdsVersion: string }): Map<string, string> {
  const files = new Map<string, string>();
  for (const o of obs) {
    if (!isWaterKind(o.kind)) continue;
    const s = w[o.id];
    const name = weekFile(o.id);
    if (!s || !name) continue;
    const body: Record<string, unknown> = { ...head, id: o.id, kind: o.kind, name: o.name };
    if (o.bank !== undefined) body.bank = o.bank;
    if (o.bmaCrit !== undefined) body.bmaCrit = o.bmaCrit;
    Object.assign(body, { t0: s.t0, step: HS, v: s.v });
    files.set(`data/week/${name}.json`, JSON.stringify(body));
  }
  return files;
}
