import type { Level } from '../../core/types';

export interface HState { level: Level; since: string; recent: { level: Level; at: string }[] }
const HOLD_MS = 30 * 60e3;

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
