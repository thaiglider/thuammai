import { FRESH_MIN } from './thresholds';
import { ageMin, isTooFarInFuture } from './time';
import type { Observation } from './types';

/** A reading we may still present as current: computed (not held/stale), non-zero level, within its kind's freshness window. */
export function isFreshObs(o: Observation, now: Date): boolean {
  if (o.held || o.flags?.includes('stale') || !(o.level > 0)) return false;
  const t = new Date(o.t);
  if (Number.isNaN(t.getTime()) || isTooFarInFuture(t, now)) return false;
  return ageMin(o.t, now) <= FRESH_MIN[o.kind];
}
