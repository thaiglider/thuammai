import { errorCounts, type Counts, type LogEvent } from '../../../src/alerts/log';
import { kumaStatus } from './health-flags';
import type { AdvisoryLock } from './lock';
import { newLoopState, tick, type LoopDeps, type LoopState } from './loop';

export const HEARTBEAT_MS = 30_000;
export const TICK_MS = 60_000;
export const STUCK_MS = 10 * 60_000;
export const STOP_WAIT_MS = 45_000;
/** Unlocking on SIGTERM waits at most this long (the database may have vanished mid-shutdown). */
export const RELEASE_WAIT_MS = 1_000;
/** Hard bound after SIGTERM: exit(0) whatever still hangs. With onceExit's 3-s close, the process is
 *  gone ≤ 50 s after SIGTERM — inside compose's 60-s stop_grace_period (ruling T7-2). */
export const STOP_HARD_MS = 47_000;
export const LOCK_RETRY_MS = 60_000;
/** A NOTIFY brings the next tick forward to this long after the previous tick ended (phase-3C spec §5.2). */
export const WAKE_GAP_MS = 2_000;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void;
}
const REAL: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface ProcessDeps {
  loop: LoopDeps; lock: AdvisoryLock;
  heartbeat(at: Date): Promise<void>;
  /** false when the push failed (counted as kuma_failed; the URL is a secret, never logged). */
  kuma(status: 'up' | 'down', msg: string): Promise<boolean>;
  exit(code: number): void;
  /** Real wall clock (ms) — heartbeat times and the stuck-tick watchdog. */
  clock(): number;
  sleep(ms: number): Promise<void>;
  timers?: Timers;
  log(event: LogEvent, counts: Counts): void;
  /** Tests: replaces tick(loop, state). */
  tickFn?: () => Promise<void>;
  state?: LoopState;
  /** 0|1 config flags for the `start` line (final review M5). */
  startFlags?: Counts;
}

/** The alerts process (spec §4.3): lock first; then a 30-second heartbeat (tick_at + Kuma push with
 *  the health flags) that keeps beating during long runs; ticks every 60 s, never overlapping; a
 *  tick running >10 min or a lost lock connection → exit 1 (Docker restarts us; at-least-once
 *  holds); SIGTERM → no new batch, wait ≤45 s for the current one, release, exit 0. */
export function startAlerts(p: ProcessDeps): { state: LoopState; started: Promise<void>; stop(): Promise<void>; wake(): void } {
  const s = p.state ?? newLoopState();
  const T = p.timers ?? REAL;
  const runTick = p.tickFn ?? (() => tick(p.loop, s));
  let stopping = false;
  let locked = false;
  let current: Promise<void> | null = null;
  let tickStarted: number | null = null;
  let tickTimer: unknown = null;
  let hbTimer: unknown = null;
  let stopPromise: Promise<void> | null = null;
  let lastTickEnd = 0;
  let wakeSoon = false;
  p.loop.alert.stopping = () => stopping;
  // No premature "up": until the first tick has computed the health flags, Kuma hears nothing
  // (unless paused, which is known at start).
  if (p.loop.paused) s.flags = ['paused'];
  let flagsReady = p.loop.paused;

  let beating = false;
  const beat = async (): Promise<void> => {
    // The watchdog first, outside the overlap guard: a hanging heartbeat must not hide a stuck run.
    if (tickStarted !== null && p.clock() - tickStarted > STUCK_MS) {
      p.log('error', { run_stuck: 1 });
      p.exit(1);
      return;
    }
    // One beat at a time: a slow database must not pile up heartbeat queries every 30 s.
    if (beating) return;
    beating = true;
    try {
      if (!(await p.lock.ping())) return; // onLost exits
      try { await p.heartbeat(new Date(p.clock())); } catch { p.log('error', { heartbeat_failed: 1 }); }
      // The Kuma URL holds a token: a failure is only counted (kuma_failed in the tick counts).
      if (flagsReady && !(await p.kuma(kumaStatus(s.flags), s.flags.join(',')).catch(() => false))) {
        s.tickCounts.kuma_failed = (s.tickCounts.kuma_failed ?? 0) + 1;
      }
    } catch (e) {
      p.log('error', errorCounts(e));
    } finally {
      beating = false;
    }
  };

  const loopOnce = async (): Promise<void> => {
    tickTimer = null;
    if (stopping) return;
    tickStarted = p.clock();
    current = runTick().then(
      () => { flagsReady = true; },
      (e: unknown) => {
        p.log('error', errorCounts(e));
        // The flags were not recomputed: never let Kuma read a stale "up" from before.
        s.flags = [...s.flags.filter((f) => f !== 'tick_error'), 'tick_error'];
        flagsReady = true;
      },
    );
    await current;
    current = null;
    tickStarted = null;
    lastTickEnd = p.clock();
    const wait = wakeSoon ? WAKE_GAP_MS : TICK_MS;
    wakeSoon = false;
    if (!stopping) tickTimer = T.setTimeout(() => { void loopOnce(); }, wait);
  };

  const started = (async () => {
    while (!stopping && !(await p.lock.tryAcquire())) {
      p.log('skip', { lock_held: 1 });
      await p.sleep(LOCK_RETRY_MS);
    }
    if (stopping) return;
    locked = true;
    p.lock.onLost(() => { p.log('error', { lock_lost: 1 }); p.exit(1); });
    p.log('start', { paused: p.loop.paused ? 1 : 0, ...p.startFlags });
    hbTimer = T.setInterval(() => { void beat(); }, HEARTBEAT_MS);
    // The first beat before the first tick (ProcessDeps.heartbeat is time-bounded in bin/alerts.ts).
    await beat();
    await loopOnce();
  })().catch((e: unknown) => { p.log('error', errorCounts(e)); p.exit(1); });

  return {
    state: s,
    started,
    stop() {
      stopPromise ??= stopOnce();
      return stopPromise;
    },
    /** NOTIFY thuammai_wake: never two ticks at once — during a tick only the following wait shrinks. */
    wake() {
      if (stopping || !locked) return;
      if (current) { wakeSoon = true; return; }
      if (tickTimer === null) return;
      T.clearTimeout(tickTimer);
      tickTimer = T.setTimeout(() => { void loopOnce(); }, Math.max(0, lastTickEnd + WAKE_GAP_MS - p.clock()));
    },
  };

  /** SIGTERM (and SIGINT) — once, however often it is asked. */
  async function stopOnce(): Promise<void> {
    stopping = true;
    if (!locked) { p.log('stop', {}); p.exit(0); return; }
    // Whatever hangs below (a tick or the unlock query on a database that vanished), exit in time.
    const hard = T.setTimeout(() => { p.log('stop', { stop_timeout: 1 }); p.exit(0); }, STOP_HARD_MS);
    if (tickTimer !== null) T.clearTimeout(tickTimer);
    if (current) await Promise.race([current, p.sleep(STOP_WAIT_MS)]);
    if (hbTimer !== null) T.clearInterval(hbTimer);
    await Promise.race([p.lock.release().catch(() => undefined), p.sleep(RELEASE_WAIT_MS)]);
    T.clearTimeout(hard);
    p.log('stop', {});
    p.exit(0);
  }
}
