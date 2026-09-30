import { hasIndependentPair } from './geo';
import { AREA, CORROB } from './thresholds';
import type { Level, Observation } from './types';

export interface AreaLevel { level: Level; n2: number; n3: number; n4: number; N: number; top: string[] }

const WATER = new Set(['road', 'canal', 'river']);

export interface AreaOpts {
  /** An urgent report (`isUrgentReport`) lies inside the area — lets river-only corroboration reach 4. */
  urgentReport?: boolean;
}

export function assessArea(obs: readonly Observation[], opts: AreaOpts = {}): AreaLevel {
  const w = obs.filter((o) => WATER.has(o.kind) && o.level > 0);
  const N = w.length;
  const count = (l: number) => w.filter((o) => o.level >= l).length;
  const top = [...w].sort((a, b) => b.level - a.level).slice(0, 3).filter((o) => o.level >= 2).map((o) => o.id);
  const res = (level: Level): AreaLevel => ({ level, n2: count(2), n3: count(3), n4: count(4), N, top });
  if (!N) return res(0);
  for (const L of [4, 3, 2] as const) {
    const S = w.filter((o) => o.level >= L);
    if (L === 4 && S.some((o) => o.kind === 'road' || o.kind === 'canal')) return res(4);
    if (!(S.length / N >= AREA.minShare && hasIndependentPair(S, CORROB.independentKm))) continue;
    // River-only 4 needs more rivers or a confirming report (spec 2026-10-01 §3); else fall through to 3.
    if (L === 4 && !(S.filter((o) => o.kind === 'river').length >= AREA.riverOnly4 || opts.urgentReport)) continue;
    return res(L);
  }
  return res(1);
}

export function districtOf(amphoeTh: string | undefined, districts: readonly { code: string; th: string }[]): string | undefined {
  if (!amphoeTh) return undefined;
  const name = amphoeTh.replace(/^เขต\s*/, '').trim();
  return districts.find((d) => d.th === name)?.code;
}
