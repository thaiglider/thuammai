import type { History } from './history';
import { isErratic, isStuck, r3h, removeDropouts, slope } from './rise';
import { BKK_METRO, CANAL, DAM, DROP_FACTOR, FRESH_MIN, HELD_MAX_H, HISTORY, RAIN_BKK, RAIN_OTHER, RECOVERY_H, RISE, RIVER, ROAD } from './thresholds';
import { ageMin } from './time';
import { isWaterKind } from './trend';
import type { Flag, Level, Observation, RawObs } from './types';

/** Freeboard in metres rounded to mm so that e.g. 5 − 4.8 compares as exactly 0.2. */
const freeboard = (bank: number, v: number) => Math.round((bank - v) * 1000) / 1000;

export function baseLevel(o: RawObs & { r3h?: number }): Level {
  switch (o.kind) {
    case 'river': {
      if (o.bank !== undefined) {
        const fb = freeboard(o.bank, o.v);
        return fb <= RIVER.fb4 ? 4 : fb <= RIVER.fb3 ? 3 : fb <= RIVER.fb2 ? 2 : 1;
      }
      return o.sit === 5 ? 2 : 1;
    }
    case 'canal': {
      if (o.bank !== undefined) {
        const fb = freeboard(o.bank, o.v);
        if (fb <= CANAL.fb4) return 4;
        if (fb < CANAL.fb3) return 3;
        if (fb < CANAL.fb2) return 2;
      }
      return o.bmaCrit !== undefined && o.v >= o.bmaCrit ? 2 : 1;
    }
    case 'road':
      return o.v >= ROAD.l4 ? 4 : o.v >= ROAD.l3 ? 3 : o.v >= ROAD.l2 ? 2 : 1;
    case 'rain': {
      if (BKK_METRO.includes(o.prov)) {
        const r1 = o.r1h ?? 0;
        const r3 = o.r3h ?? 0;
        if (r1 >= RAIN_BKK.r1h3 || r3 >= RAIN_BKK.r3h3) return 3;
        if (r1 >= RAIN_BKK.r1h2 || r3 >= RAIN_BKK.r3h2) return 2;
        return 1;
      }
      return o.v >= RAIN_OTHER.d3 ? 3 : o.v >= RAIN_OTHER.d2 ? 2 : 1;
    }
    case 'dam':
      return o.v >= DAM.l2 ? 2 : 1;
  }
}

export type BankFlag = 'bank_suspect' | 'bank_low_side';
const isNum = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/** Bank quality of one river reading (spec 2026-10-01 §1.1). `b` = min_bank (present, non-zero),
 *  `left`/`right` = ThaiWater left_bank/right_bank. Differences are compared rounded to mm.
 *  - more than dropAbove over b → drop (broken sensor or datum)
 *  - farAbove or more over b, unless usable L/R say the water is below both banks → no flag (level 4)
 *  - L/R unusable (missing, or more than lrMaxDiff from b) or b not within bankMatch of min(L,R) → bank_suspect
 *  - confirmed bank and b ≤ v < max(L,R) → bank_low_side */
export function riverBank({ v, b, left, right }: { v: number; b: number; left?: number; right?: number }): { flags: BankFlag[]; drop: boolean } {
  const above = -freeboard(b, v);
  if (above > RIVER.dropAbove) return { flags: [], drop: true };
  const lrOk = isNum(left) && isNum(right)
    && Math.abs(freeboard(left, b)) <= RIVER.lrMaxDiff && Math.abs(freeboard(right, b)) <= RIVER.lrMaxDiff;
  const lo = lrOk ? Math.min(left, right) : NaN;
  const hi = lrOk ? Math.max(left, right) : NaN;
  if (above >= RIVER.farAbove && (!lrOk || freeboard(lo, v) <= 0)) return { flags: [], drop: false };
  if (!lrOk || Math.abs(freeboard(lo, b)) > RIVER.bankMatch) return { flags: ['bank_suspect'], drop: false };
  if (above >= 0 && freeboard(hi, v) > 0) return { flags: ['bank_low_side'], drop: false };
  return { flags: [], drop: false };
}

/** A river station whose bank is unconfirmed or only overtopped on its low side tops out at 3 (§1.2). */
const BANK_CAP = 3;
function bankCapped(o: RawObs): boolean {
  return o.kind === 'river' && !!o.flags?.some((f) => f === 'bank_suspect' || f === 'bank_low_side');
}

/** `missing`: ids that disappeared from the current feed (re-supplied from their last fresh
 *  reading) — always treated as stale so they can only ever be held, never computed afresh. */
export interface StatusContext { now: Date; history: History; historyH: number; missing?: ReadonlySet<string> }

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

function riseBonus(o: Observation): boolean {
  if (o.kind !== 'river' && o.kind !== 'canal') return false;
  if (o.bank === undefined || o.slope3h === undefined || o.slope3h <= 0) return false;
  if (o.flags?.includes('tidal') || o.flags?.includes('erratic')) return false;
  const fb = freeboard(o.bank, o.v);
  return fb <= RISE.fbMax && fb <= o.slope3h * RISE.horizonH;
}

export function computeStatus(raws: RawObs[], ctx: StatusContext): Observation[] {
  const out: Observation[] = [];
  const nowMs = ctx.now.getTime();
  const rulesOn = ctx.historyH >= HISTORY.minForRules;
  for (const r of raws) {
    const age = ageMin(r.t, ctx.now);
    const fresh = FRESH_MIN[r.kind];
    if (age > fresh * DROP_FACTOR) continue;
    const flags: Flag[] = [...(r.flags ?? [])];
    const o: Observation = { ...r, level: 0, flags };
    if (age > fresh || ctx.missing?.has(r.id)) {
      flags.push('stale');
      // A tidal peak passes within hours, so a held tidal reading would not describe now (spec 2026-10-01 §2).
      const last = flags.includes('tidal') ? undefined : ctx.history.lastLevel[r.id];
      if (last && last.level >= 3 && nowMs - Date.parse(last.t) <= HELD_MAX_H * 3600e3) {
        const held = (bankCapped(r) ? Math.min(last.level, BANK_CAP) : last.level) as Level;
        o.level = held;
        o.held = { level: held, lastFreshAt: last.t };
        flags.push('held');
      }
      attachHiAt(o, ctx.history, nowMs);
      out.push(tidy(o));
      continue;
    }
    const samples = ctx.history.series[r.id] ?? [];
    if (rulesOn) {
      if (r.kind === 'road' && isStuck(samples, nowMs)) {
        // A sensor frozen at a shallow value is dropped; one frozen at a flood depth is kept
        // (flagged) — showing a possible flood is safer than hiding a real one.
        if (r.v < ROAD.l3) continue;
        flags.push('stuck');
      }
      if ((r.kind === 'river' || r.kind === 'canal') && isErratic(samples, nowMs)) flags.push('erratic');
      if (r.kind === 'river' || r.kind === 'canal' || r.kind === 'road') {
        const s = slope(removeDropouts(samples), nowMs);
        if (s) o.slope3h = round(s.perHour, 3);
      }
    }
    if (r.kind === 'rain') {
      const lastSample = samples[samples.length - 1];
      if (lastSample && Math.abs(Date.parse(r.t) - lastSample.t) <= 15 * 60e3) {
        const v3 = r3h(samples);
        if (v3 !== null) o.r3h = round(v3, 1);
      }
    }
    let level = baseLevel(o);
    if (rulesOn && riseBonus(o)) level = Math.min(4, level + 1) as Level;
    if (bankCapped(r)) level = Math.min(level, BANK_CAP) as Level;
    o.level = level;
    ctx.history.lastLevel[r.id] = { level, t: r.t };
    if (level >= 3 && isWaterKind(r.kind)) (ctx.history.highAt ??= {})[r.id] = r.t;
    attachHiAt(o, ctx.history, nowMs);
    out.push(tidy(o));
  }
  return out;
}

/** Publish when the station was last at ≥3 on a fresh reading, if within RECOVERY_H. */
function attachHiAt(o: Observation, history: History, nowMs: number): void {
  const hi = history.highAt?.[o.id];
  if (hi !== undefined && isWaterKind(o.kind) && nowMs - Date.parse(hi) <= RECOVERY_H * 3600e3) o.hiAt = hi;
}

function tidy(o: Observation): Observation {
  if (!o.flags?.length) delete o.flags;
  return o;
}
