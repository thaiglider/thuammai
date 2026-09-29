import type { Level } from './types';

export interface HState { level: Level; since: string; recent: { level: Level; at: string }[] }
/** The card shows the highest raw level of the last 30 minutes (ALERT.hystHoldMin — test pins it). */
export const HOLD_MS = 30 * 60e3;

export function smooth(prev: HState | null, next: Level, generatedAt: string): HState {
  const recent = prev ? (prev.recent ?? [{ level: prev.level, at: prev.since }]) : [];
  const newest = recent.length ? recent[recent.length - 1] : null;

  if (prev && newest && Date.parse(generatedAt) < Date.parse(newest.at)) {
    return prev; // out-of-order/stale snapshot: unchanged
  }

  const withNext =
    newest && Date.parse(generatedAt) === Date.parse(newest.at)
      ? recent.slice(0, -1).concat([{ level: next, at: generatedAt }])
      : recent.concat([{ level: next, at: generatedAt }]);

  const cutoff = Date.parse(generatedAt) - HOLD_MS;
  const kept = withNext.filter((e) => Date.parse(e.at) >= cutoff);

  const level: Level = next === 0 ? 0 : (Math.max(...kept.map((e) => e.level)) as Level);
  const since = prev && level === prev.level ? prev.since : generatedAt;

  return { level, since, recent: kept };
}

/** What the card would show, reduced to what alerts need: 0 (no data), below 3, 3 or 4. */
export type Shown = 0 | 'lt3' | 3 | 4;
/** Times of the latest raw level ≥3 and =4, kept only while inside the hold window. */
export interface PlaceHyst { l3?: string; l4?: string }

/** Equivalent to smooth() cut to {0, <3, 3, 4} (property test). The caller processes each
 *  place's snapshots in increasing time order (the alerts job skips older/equal snapshots). */
export function alertShown(prev: PlaceHyst | undefined, raw: Level, gen: string): { shown: Shown; next: PlaceHyst } {
  const cutoff = Date.parse(gen) - HOLD_MS;
  const l3 = raw >= 3 ? gen : prev?.l3;
  const l4 = raw === 4 ? gen : prev?.l4;
  const next: PlaceHyst = {};
  if (l3 !== undefined && Date.parse(l3) >= cutoff) next.l3 = l3;
  if (l4 !== undefined && Date.parse(l4) >= cutoff) next.l4 = l4;
  const shown: Shown = raw === 0 ? 0 : next.l4 ? 4 : next.l3 ? 3 : 'lt3';
  return { shown, next };
}
