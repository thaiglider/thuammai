import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { answerLineQuestions, refreshLineUsage } from '../../../src/alerts/line';
import { lineMonth, quotaLow } from '../../../src/alerts/line-budget';
import type { Counts, LogEvent } from '../../../src/alerts/log';
import { answerQuestions, NO_SNAPSHOT, runAlerts, type AlertDeps, type RunResult } from '../../../src/alerts/main';
import { loadSnapshot, refreshFreshness, type Snapshot } from '../../../src/alerts/snapshot';
import type { ProvinceGeo } from '../../../src/core/types';
import type { Db } from '../db/db';
import { readLineUsage } from '../line/store';
import { runCleanup } from './cleanup';
import { downloadSnapshot, fetchMetaGen, genInFuture } from './fetch-snapshot';
import { healthFlags } from './health-flags';
import { capsUsage, storedGen, type CapsUsage } from './run-state';

export const MAX_ATTEMPTS = 3;
export const TICK_LOG_EVERY = 60;
export const CLEANUP_HOUR_BKK = 3;

export interface LoopDeps {
  alert: AlertDeps; db: Db; siteUrl: string; provinces: ProvinceGeo[]; tmpDir: string; paused: boolean;
  log(event: LogEvent, counts: Counts): void;
}
export interface LoopState {
  /** The last loaded snapshot (kept for answering questions between runs). */
  snap: Snapshot | null;
  /** The last Pages gen finished (processed or given up). */
  doneGen: string | null;
  attempts: number;
  pagesGen: string | null;
  fetchFailingSince: number | null;
  deferredStreak: number;
  lastCounts: Counts | null;
  cleanupDay: string | null;
  ticks: number;
  tickCounts: Counts;
  flags: string[];
}
export const newLoopState = (): LoopState => ({ snap: null, doneGen: null, attempts: 0, pagesGen: null, fetchFailingSince: null, deferredStreak: 0, lastCounts: null, cleanupDay: null, ticks: 0, tickCounts: {}, flags: [] });

const add = (c: Counts, more: Counts) => { for (const [k, v] of Object.entries(more)) c[k] = (c[k] ?? 0) + v; };
const bkk = (d: Date) => new Date(d.getTime() + 7 * 3600e3);
const newer = (gen: string, than: string | null) => than === null || Date.parse(gen) > Date.parse(than);
const stopping = (d: LoopDeps): boolean => d.alert.stopping?.() === true;
const retryable = (r: RunResult) => r.event === 'error' || r.counts.db_unavailable === 1;

/** LINE questions (phase-3C spec §5.2): never lets a failure stop the tick. */
async function lineAnswers(d: LoopDeps, s: LoopState, now: Date): Promise<void> {
  try {
    add(s.tickCounts, await answerLineQuestions(d.alert, s.snap ? refreshFreshness(s.snap, now) : NO_SNAPSHOT));
  } catch {
    add(s.tickCounts, { line_pending_error: 1 });
  }
}

/** Download + load one snapshot into a throw-away directory; null when it must be fetched again
 *  (download failed, or loadSnapshot saw files from two runs / a missing file — F1-10). */
async function download(d: LoopDeps, s: LoopState, now: Date, t: number): Promise<Snapshot | null> {
  const dir = join(d.tmpDir, `snap-${t}`);
  try {
    const got = await downloadSnapshot(d.siteUrl, d.provinces, d.alert.fetch, dir, t);
    // Over the total size cap (final review M3): counted, and fetched again like any failure.
    if (got === 'too_big') add(s.tickCounts, { snapshot_too_big: 1 });
    if (got !== 'ok') return null;
    const snap = loadSnapshot(dir, d.provinces, now);
    return snap.reason === 'mixed' || snap.reason === 'missing' ? null : snap;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One tick (spec §4.3 steps 2–8). The caller never overlaps ticks. */
export async function tick(d: LoopDeps, s: LoopState): Promise<void> {
  // SIGTERM: no new work at all. A run that saw SIGTERM does not save its state (runAlerts), so
  // alert_run.gen stays put and the next process re-evaluates the same gen and sends what was
  // deferred; the queued questions stay queued for it too.
  if (stopping(d)) return;
  const now = d.alert.now();
  s.ticks++;
  if (!d.paused) {
    // LINE first, from the snapshot in memory (G-13): the download below may take up to 60 s of the
    // reply token's minute. With nothing in memory yet, wait for the download instead.
    if (s.snap && !stopping(d)) await lineAnswers(d, s, now);
    let ran = false;
    const t = now.getTime();
    const gen = await fetchMetaGen(d.siteUrl, d.alert.fetch, t);
    if (gen === null) {
      s.fetchFailingSince ??= t;
      add(s.tickCounts, { fetch_error: 1 });
    } else if (genInFuture(gen, t)) {
      // Not trusted: never downloaded, run or compared (it would block every real gen after it).
      s.fetchFailingSince ??= t;
      add(s.tickCounts, { gen_future: 1 });
    } else {
      s.pagesGen = gen;
      if (!newer(gen, s.doneGen)) {
        s.fetchFailingSince = null;
      } else {
        if (s.snap?.gen !== gen) {
          const snap = await download(d, s, now, t);
          if (snap) { s.snap = snap; s.attempts = 0; s.fetchFailingSince = null; } else { s.fetchFailingSince ??= t; add(s.tickCounts, { fetch_retry: 1 }); }
        }
        // SIGTERM during the download: no run starts (the gen stays undone for the next process).
        if (s.snap?.gen === gen && !stopping(d)) {
          ran = true;
          const r = await runAlerts(d.alert, refreshFreshness(s.snap, now));
          d.log(r.event, r.counts);
          s.lastCounts = r.counts;
          if (retryable(r)) {
            s.attempts++;
            if (s.attempts >= MAX_ATTEMPTS) { s.doneGen = gen; d.log('skip', { gen_given_up: 1 }); }
          } else {
            s.doneGen = gen;
            const deferred = (r.counts.deferred ?? 0) + (r.counts.push_deferred ?? 0) + (r.counts.tg_deferred ?? 0);
            if (r.event === 'run') s.deferredStreak = deferred > 0 ? s.deferredStreak + 1 : 0;
          }
        }
      }
    }
    // Step 5: questions every tick from the snapshot in memory, freshness re-checked now (R16);
    // with none in memory, the honest "unusable" answer (final review M2).
    if (!ran && !stopping(d)) {
      const q = await answerQuestions(d.alert, s.snap ? refreshFreshness(s.snap, now) : NO_SNAPSHOT);
      add(s.tickCounts, q.counts);
      if (q.counts.tg_auth) s.lastCounts = { ...(s.lastCounts ?? {}), tg_auth: q.counts.tg_auth };
    }
    // Questions that came during the download or the run (and the first tick after a start).
    if (!stopping(d)) await lineAnswers(d, s, now);
    if (!stopping(d)) {
      try {
        const rc = await refreshLineUsage(d.alert, now);
        add(s.tickCounts, rc);
        if (rc.line_auth) s.lastCounts = { ...(s.lastCounts ?? {}), line_auth: 1 };
      } catch {
        add(s.tickCounts, { line_check_error: 1 });
      }
    }
  }
  // Step 6: daily cleanup (also while paused — deleting old data is a promise to users).
  const day = bkk(now).toISOString().slice(0, 10);
  if (bkk(now).getUTCHours() >= CLEANUP_HOUR_BKK && s.cleanupDay !== day) {
    s.cleanupDay = day;
    d.log('cleanup', { ...(await runCleanup(d.db, now)) });
  }
  // Step 7: health flags for the next heartbeat.
  let runGen: string | null = null;
  let usage: CapsUsage | null = null;
  let dbOk = true;
  let lineLow = false;
  try {
    runGen = await storedGen(d.db);
    usage = await capsUsage(d.db, now.toISOString().slice(0, 10));
    lineLow = quotaLow(await readLineUsage(d.db, lineMonth(now)));
  } catch {
    dbOk = false;
  }
  s.flags = healthFlags({ paused: d.paused, now, pagesGen: s.pagesGen, runGen, lastCounts: s.lastCounts, deferredStreak: s.deferredStreak, usage, fetchFailingSince: s.fetchFailingSince, dbOk, lineLow });
  // Step 8: one summary line every 60 ticks.
  if (s.ticks % TICK_LOG_EVERY === 0) {
    d.log('tick', { ticks: s.ticks, ...s.tickCounts });
    s.tickCounts = {};
  }
}
