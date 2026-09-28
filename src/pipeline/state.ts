import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyHistory, type History } from '../core/history';
import type { RawObs, SourceId } from '../core/types';
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
  /** Hourly evaluation snapshots for evaluate.yml (Plan C). Optional for legacy states. */
  evalLog?: EvalLog;
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
