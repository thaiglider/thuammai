import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyHistory, type History } from '../core/history';
import type { RawObs, SourceId } from '../core/types';
import type { WeekStore } from '../core/week';
import type { EvalLog } from './eval-log';

export interface PipelineState {
  v: 1;
  savedAt: string | null;
  history: History;
  lastGood: Partial<Record<SourceId, { at: string; data: unknown }>>;
  traffyCoveredSince?: string;
  /** Traffy coverage window (h, ≤6) as of the last successful Traffy fetch; frozen while Traffy fails. */
  traffyWindowH?: number;
  /** ISO +07:00 timestamp of the start of the current unbroken run of pipeline invocations;
   *  reset whenever the state is fresh or the gap since the last run exceeds an hour.
   *  Used to measure `historyH` from wall-clock elapsed time rather than sample timestamps. */
  historySince?: string;
  /** Last fresh raw reading of every station whose level was ≥3, so a station that vanishes
   *  from its feed can still be published as held (spec §4 "stale/หาย"). Optional for legacy states. */
  lastSeen?: Record<string, RawObs>;
  /** Set once lastSeen has been cleared of river entries saved before bank verdicts existed (Plan N A1). */
  lastSeenBankJudged?: boolean;
  /** Hourly evaluation snapshots for evaluate.yml (Plan C). Optional for legacy states. */
  evalLog?: EvalLog;
  /** Hourly 7-day water history for the chart (spec 2026-09-30 §4.1). Optional for legacy states. */
  week?: WeekStore;
  /** ISO +07:00 of the last failed OSM hospitals fetch; no retry for HOSPITAL.retryMin after it. */
  hospitalsAt?: string;
}

export const emptyState = (): PipelineState => ({ v: 1, savedAt: null, history: emptyHistory(), lastGood: {} });

function valid(x: any): x is PipelineState {
  return x && x.v === 1
    && typeof x.history === 'object' && x.history !== null
    && typeof x.history.series === 'object' && x.history.series !== null
    && typeof x.history.lastLevel === 'object' && x.history.lastLevel !== null
    && Array.isArray(x.history.events)
    && typeof x.lastGood === 'object' && x.lastGood !== null;
}

/** Cache file first; else the copy published on the site (`data/_state.json`); else empty. */
export async function loadState(path: string, siteUrl?: string, fetchImpl: typeof fetch = fetch): Promise<PipelineState> {
  if (existsSync(path)) {
    try {
      const x = JSON.parse(readFileSync(path, 'utf8'));
      if (valid(x)) return x;
    } catch { /* fall through */ }
  }
  if (siteUrl) {
    try {
      const res = await fetchImpl(`${siteUrl.replace(/\/$/, '')}/data/_state.json?v=${Date.now()}`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const x = await res.json();
        if (valid(x)) return x;
      }
    } catch { /* fall through */ }
  }
  return emptyState();
}

export function saveState(path: string, st: PipelineState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(st));
}

/** Plan N A1 rollout: a river reading remembered in lastSeen before riverBank() existed carries no
 *  bank verdict and no left/right banks to judge one, so a station that then vanished from the feed
 *  would be held at 4 unflagged. Once per state, drop such entries whose last level is 4 (the
 *  station simply is not held); entries saved afterwards have been judged by parseRiver. */
export function dropUnjudgedLastSeen(st: PipelineState): void {
  if (st.lastSeenBankJudged) return;
  for (const [id, r] of Object.entries(st.lastSeen ?? {})) {
    const judged = r.flags?.some((f) => f === 'bank_suspect' || f === 'bank_low_side');
    if (r.kind === 'river' && !judged && st.history.lastLevel[id]?.level === 4) delete st.lastSeen![id];
  }
  st.lastSeenBankJudged = true;
}
