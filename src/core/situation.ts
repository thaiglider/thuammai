import type { Assessment } from './risk';
import { RECOVERY_H, TREND } from './thresholds';
import { isWaterKind, type Trend } from './trend';
import type { Level, Observation } from './types';

export type Situation = 'NO_DATA' | 'NORMAL' | 'PRE_FLOOD' | 'FLOODED_RISING' | 'FLOODED_STABLE' | 'FLOODED_FALLING' | 'RECOVERY';
export type Group = 'none' | 'approach' | 'flooded' | 'receding';

/** A direct water station behind this point was at ≥3 (fresh) within RECOVERY_H. */
function recentlyHigh(a: Assessment, obs: readonly Observation[], now: Date): boolean {
  const byId = new Map(obs.map((o) => [o.id, o]));
  return a.reasons.some((r) => {
    if (!isWaterKind(r.kind) || !r.direct || r.stationId === undefined) return false;
    const hi = byId.get(r.stationId)?.hiAt;
    if (hi === undefined) return false;
    const age = now.getTime() - Date.parse(hi);
    return age >= -10 * 60e3 && age <= RECOVERY_H * 3600e3;
  });
}

/** `shown` is the card's level after hysteresis, so the situation always agrees with the badge. */
export function situationOf(shown: Level, a: Assessment, trend: Trend, obs: readonly Observation[], now: Date): Situation {
  if (shown === 0) return 'NO_DATA';
  if (shown >= 3) {
    if (trend.state === 'falling') return 'FLOODED_FALLING';
    if (trend.state === 'rising') return 'FLOODED_RISING';
    return 'FLOODED_STABLE';
  }
  if (trend.state !== 'rising' && recentlyHigh(a, obs, now)) return 'RECOVERY';
  if (shown === 2) return 'PRE_FLOOD';
  if (trend.state === 'rising' && trend.direct === true && (trend.cmPerH ?? 0) >= TREND.fastCmH) return 'PRE_FLOOD';
  return 'NORMAL';
}

export function groupOf(s: Situation): Group {
  switch (s) {
    case 'PRE_FLOOD': return 'approach';
    case 'FLOODED_RISING': case 'FLOODED_STABLE': return 'flooded';
    case 'FLOODED_FALLING': case 'RECOVERY': return 'receding';
    default: return 'none';
  }
}
