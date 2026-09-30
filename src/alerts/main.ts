import { CAPS, LINE } from '../core/alert-config';
import type { FollowState } from '../core/alert-rule';
import { siteLink, tgAlertText } from '../core/tg-text';
import { pointAnswerText, type Stored } from './answer';
import { lineFor, sendLine } from './line';
import type { LineRepo } from './line-repo';
import { errorCounts, type Counts, type LogEvent } from './log';
import { capPlanned, evaluatePointsYielding, isTrendKind, keysToQuery, planFollows, recomputeEp, toUpdate, type Planned, type PointEval } from './plan';
import { newPushRun, sendPush, type PushRun, type SendNotification, type Vapid } from './push';
import { RepoError, type AlertRepo, type FollowRow, type PendingRow } from './repo';
import type { Snapshot } from './snapshot';
import { sendTelegram, tgSender, type Clock, type TgSend } from './telegram';

export interface AlertEnv {
  VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string;
  /** Telegram is on only when both are set; otherwise Telegram follows are deferred (not sent, not recorded). */
  TELEGRAM_BOT_TOKEN?: string; SITE_URL?: string;
  /** Links in messages people read (default SITE_URL); SITE_URL alone stays the switch for Telegram/LINE. */
  PUBLIC_URL?: string;
  /** LINE is on only with this token and SITE_URL (and a LineRepo). */
  LINE_CHANNEL_TOKEN?: string;
  /** '0' turns trend alerts (H4) off: no trend is evaluated and every place's trend run is cleared. Default on. */
  TREND_ALERTS?: string;
}
export interface AlertDeps {
  repo: AlertRepo; env: AlertEnv;
  now(): Date; fetch: typeof fetch; sendNotification: SendNotification; sleep(ms: number): Promise<void>;
  /** Wall clock for the send deadline and the Telegram pacing (default Date.now). */
  clock?(): number;
  /** Tests inject the Bot API; otherwise it is built from TELEGRAM_BOT_TOKEN. */
  tgSend?: TgSend;
  /** true once SIGTERM arrived: no new batch starts (spec §4.3 "หยุด"). */
  stopping?(): boolean;
  /** LINE questions and pushes (phase 3C); absent → LINE off. */
  lineRepo?: LineRepo;
}
/** No new send after this long from the start of the run (spec §7.5): below the 10-minute
 *  snapshot cycle and the 10-minute stuck-run watchdog of the alerts process. */
export const SEND_BUDGET_MS = 7 * 60_000;
export const PUSH_CONCURRENCY = 100;

export interface RunResult { event: LogEvent; counts: Counts; exitCode: number }
/** Telegram for this run; its clock is the run's clock, so there is one send deadline. */
interface Tg { send: TgSend; site: string; clock: Clock }

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const add = (counts: Counts, more: Counts) => { for (const [k, v] of Object.entries(more)) counts[k] = (counts[k] ?? 0) + v; };

/** Trend alerts are on unless TREND_ALERTS is exactly '0'. */
export const trendAlertsOn = (e: Pick<AlertEnv, 'TREND_ALERTS'>): boolean => e.TREND_ALERTS !== '0';

/** The base of every link in a message: PUBLIC_URL, else SITE_URL, with a trailing slash. */
export function linkBase(e: Pick<AlertEnv, 'SITE_URL' | 'PUBLIC_URL'>): string {
  const u = e.PUBLIC_URL || e.SITE_URL || '';
  return u.endsWith('/') ? u : `${u}/`;
}
function tgFor(d: AlertDeps, clock: () => number): Tg | null {
  const e = d.env;
  if (!e.TELEGRAM_BOT_TOKEN || !e.SITE_URL) return null;
  // Links need the site URL with a trailing slash (ruling 12).
  return { send: d.tgSend ?? tgSender(e.TELEGRAM_BOT_TOKEN, d.fetch), site: linkBase(e), clock: { now: clock, sleep: d.sleep } };
}
/** A store failure is not our bug (F1-4): skip, the loop retries this gen. */
const failed = (err: unknown, counts: Counts = {}, event: LogEvent = 'skip'): RunResult => (err instanceof RepoError
  ? { event, counts: { ...counts, db_unavailable: 1 }, exitCode: 0 }
  : { event: 'error', counts: { ...counts, ...errorCounts(err) }, exitCode: 1 });

/** One run over a newly published snapshot (phase-2 spec §5.1 on the repository). Never throws. */
export async function runAlerts(d: AlertDeps, snap: Snapshot): Promise<RunResult> {
  const e = d.env;
  const clock = d.clock ?? Date.now;
  if (!e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY || !e.VAPID_SUBJECT) return { event: 'error', counts: { config_missing: 1 }, exitCode: 1 };
  try {
    return await runWith(d, snap, { subject: e.VAPID_SUBJECT, publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY }, newPushRun(clock() + SEND_BUDGET_MS, clock), tgFor(d, clock));
  } catch (err) {
    return failed(err);
  }
}

async function runWith(d: AlertDeps, snap: Snapshot, vapid: Vapid, run: PushRun, tg: Tg | null): Promise<RunResult> {
  const started = Date.now();
  if (snap.gen === '') return { event: 'skip', counts: { [`snapshot_${snap.reason}`]: 1 }, exitCode: 0 };
  const places = await d.repo.places();
  const prev = await d.repo.loadState();
  const stored: Stored = (k) => prev?.places[k];
  const counts: Counts = { places: places.length };
  if (!snap.ok) counts[`snapshot_${snap.reason}`] = 1;
  if (snap.ok && prev && Date.parse(snap.gen) <= Date.parse(prev.gen)) {
    // No alerts from a snapshot already evaluated (D2), but questions are still answered (E11).
    counts.not_newer = 1;
    const sigterm = d.stopping?.() === true;
    const bad = tg ? await answerPendingSafe(d, snap, new Map(), stored, tg, run, CAPS.tgPerRun, sigterm, counts) : null;
    if (run.timedOut) counts.send_deadline = 1;
    if (sigterm) counts.stopping = 1;
    return bad ?? { event: 'skip', counts, exitCode: 0 };
  }

  const trendOn = trendAlertsOn(d.env);
  const ev = await evaluatePointsYielding(snap, places, prev, 1000, trendOn);
  add(counts, ev.counts);
  const queried = keysToQuery(ev.points, snap.gen, trendOn);
  const follows: FollowRow[] = await d.repo.targets(queried);
  const planned = planFollows(follows, ev.points, snap.gen, trendOn);
  const line = lineFor(d);
  const capped = capPlanned(planned, { push: CAPS.pushPerRun, tg: CAPS.tgPerRun, line: LINE.maxApproved * LINE.placesPerUser }, { push: true, tg: tg !== null, line: line !== null });
  for (const p of capped.send) {
    counts[p.kind!] = (counts[p.kind!] ?? 0) + 1;
    if (isTrendKind(p.kind)) counts.trend = (counts.trend ?? 0) + 1;
  }
  counts.deferred = capped.deferred;

  const written = new Map<number, FollowState>();
  const record = (ps: Planned[]) => { for (const p of ps) written.set(p.f.fid, p.next); };
  // The deadline, or SIGTERM: no new batch starts (spec §4.3). Kept apart so the log tells them
  // apart: SIGTERM is `stopping=1`, never `send_deadline=1`.
  let sigterm = false;
  const halt = () => {
    if (!run.timedOut && run.clock() >= run.deadline) run.timedOut = true;
    if (d.stopping?.() === true) sigterm = true;
  };
  // State-only changes (e.g. alerted 4 → 3) need no message.
  for (const c of chunks(capped.stateOnly, CAPS.batch)) {
    await d.repo.report({ follows: c.map(toUpdate), deadTargets: [], donePending: [] });
    record(c);
  }
  // Send, then record (at-least-once): a failed report can repeat at most this one batch.
  for (const c of chunks(capped.send.filter((p) => p.f.ch === 'push'), CAPS.batch)) {
    halt();
    if (run.stopped || run.timedOut || sigterm) { counts.push_deferred = (counts.push_deferred ?? 0) + c.length; continue; }
    const out = await sendPush(c, snap.gen, d.sendNotification, vapid, d.sleep, PUSH_CONCURRENCY, run);
    add(counts, out.counts);
    if (out.ok.length || out.dead.length) {
      await d.repo.report({ follows: out.ok.map(toUpdate), deadTargets: out.dead, donePending: [] });
      record(out.ok);
    }
  }

  // Telegram after push, same priority order and send deadline; the VAPID stop is about push only.
  let tgUsed = 0;
  // A 429 stop or a wrong token (401) stops Telegram for the whole run, pending answers included.
  let tgStopped = false;
  if (tg) {
    for (const c of chunks(capped.send.filter((p) => p.f.ch === 'tg' && p.f.chat !== null && p.msg !== null), CAPS.batch)) {
      halt();
      if (tgStopped || run.timedOut || sigterm) { counts.tg_deferred = (counts.tg_deferred ?? 0) + c.length; continue; }
      const out = await sendTelegram(c.map((p) => ({ chat: p.f.chat!, text: tgAlertText(p.f.label ?? 'จุดที่ติดตาม', p.msg!, siteLink(tg.site, p.f.key)), ref: p })), tg.send, tg.clock, run.deadline);
      tgUsed += c.length;
      add(counts, out.counts);
      tgStopped = out.stopped;
      if (out.stopped && run.clock() >= run.deadline) run.timedOut = true;
      if (out.ok.length || out.dead.length) {
        await d.repo.report({ follows: out.ok.map(toUpdate), deadTargets: [...new Set(out.dead.map((p) => p.f.targetId))], donePending: [] });
        record(out.ok);
      }
    }
  }

  // LINE after Telegram (phase-3C spec §5.3), under the monthly budget (§6), same send deadline.
  const lineSend = capped.send.filter((p) => p.f.ch === 'line' && p.f.lineUser !== null && p.msg !== null);
  if (line && lineSend.length) {
    halt();
    if (run.timedOut || sigterm) counts.line_deferred = (counts.line_deferred ?? 0) + lineSend.length;
    else {
      const out = await sendLine(d, line, lineSend, snap.gen, run.deadline, run.clock);
      add(counts, out.counts);
      record(out.ok);
    }
  }

  if (run.stopped) counts.push_stopped = 1;
  // SIGTERM seen during the run (final review I1): the state is NOT saved, so alert_run.gen does
  // not move and the next process re-evaluates this same gen from the same stored state. Follows
  // already sent are recorded in `follow`, so it sends only what was deferred here (at most the
  // batch in flight repeats). The send deadline keeps phase-2 semantics: the state is saved.
  halt();
  if (!sigterm) {
    recomputeEp(ev.blob, queried, follows, written);
    if ((await d.repo.saveState(prev, ev.blob)) === 'older') counts.state_conflict = 1;
  }
  // Questions from the bot are answered every run, honestly, even when alerts stay silent (E11).
  // After SIGTERM nothing more is sent: the questions stay queued for the next process.
  halt();
  const bad = tg ? await answerPendingSafe(d, snap, ev.points, stored, tg, run, CAPS.tgPerRun - tgUsed, tgStopped || sigterm, counts) : null;
  if (run.timedOut) counts.send_deadline = 1;
  if (sigterm) counts.stopping = 1;
  counts.ms = Date.now() - started;
  try {
    await d.repo.finishRun(d.now(), counts);
  } catch (err) {
    // The state and the answers are already saved: keep this run's counts in the log line.
    return bad ?? failed(err, counts, 'run');
  }
  return bad ?? { event: 'run', counts, exitCode: 0 };
}

/** Questions are answered after the state is written, so their failure must not lose the run's
 *  counts (final review M9): `pending_error=1` plus the counts so far. A store failure is not an
 *  error (the questions stay queued); anything else is. */
async function answerPendingSafe(d: AlertDeps, snap: Snapshot, points: Map<string, PointEval>, stored: Stored, tg: Tg, run: PushRun, budget: number, stopped: boolean, counts: Counts): Promise<RunResult | null> {
  try {
    await answerPending(d.repo, await d.repo.tgPending(d.now()), snap, points, stored, tg, run, budget, stopped, counts, () => d.stopping?.() === true);
    return null;
  } catch (err) {
    counts.pending_error = 1;
    if (err instanceof RepoError) return null;
    return { event: 'error', counts: { ...counts, ...errorCounts(err) }, exitCode: 1 };
  }
}

/** Answer the queued questions within the Telegram budget and the send deadline, in chunks of
 *  CAPS.batch: before each chunk SIGTERM is checked (then the rest stays queued for the next
 *  process), and each chunk is marked done right after it is sent — so a stop, a crash or a
 *  failed report repeats at most one chunk (at-least-once, like the alerts). Answered and
 *  dead-chat questions are done; deferred ones stay queued. */
async function answerPending(repo: AlertRepo, pending: PendingRow[], snap: Snapshot, points: Map<string, PointEval>, stored: Stored, tg: Tg, run: PushRun, budget: number, stopped: boolean, counts: Counts, sigterm: () => boolean): Promise<void> {
  counts.pending = pending.length;
  if (!pending.length) return;
  // Telegram already stopped this run (429 or 401): no further request, everything waits (M2).
  const now = stopped ? [] : pending.slice(0, Math.max(0, budget));
  counts.pending_ok = 0;
  counts.pending_dead = 0;
  counts.pending_deferred = pending.length - now.length;
  let tgStopped = false;
  let halted = false;
  for (const c of chunks(now, CAPS.batch)) {
    if (!tgStopped && !halted && sigterm()) { halted = true; counts.stopping = 1; }
    if (tgStopped || halted) { counts.pending_deferred += c.length; continue; }
    const out = await sendTelegram(c.map((q) => ({ chat: q.chat, text: pointAnswerText(q, snap, points, stored, tg.site), ref: q })), tg.send, tg.clock, run.deadline);
    if (out.stopped) {
      tgStopped = true;
      if (run.clock() >= run.deadline) run.timedOut = true;
    }
    const auth = out.counts.tg_auth ?? 0;
    if (auth) counts.tg_auth = (counts.tg_auth ?? 0) + auth;
    counts.pending_ok += out.counts.tg_ok ?? 0;
    counts.pending_dead += out.counts.tg_dead ?? 0;
    counts.pending_deferred += (out.counts.tg_deferred ?? 0) + auth;
    const done = [...out.ok, ...out.dead].map((q) => q.id);
    if (done.length) await repo.report({ follows: [], deadTargets: [], donePending: done });
  }
}

/** No usable snapshot in memory at all (Pages unreachable since start, or every download mixed or
 *  missing): the questions get the honest "cannot assess this point now — not safe" answer
 *  (final review M2) instead of silently expiring after the bot promised an answer. */
export const NO_SNAPSHOT: Snapshot = { gen: '', ok: false, reason: 'missing', provinces: [], obs: new Map(), events: null, forecast: null, inputs: new Map() };

/** Between runs (every tick, spec §4.3 step 5, R16): answer queued questions from the snapshot in
 *  memory — the caller has re-checked its freshness against the current time, or passes
 *  NO_SNAPSHOT — with the stored hysteresis of just the asked keys. */
export async function answerQuestions(d: AlertDeps, snap: Snapshot): Promise<RunResult> {
  const clock = d.clock ?? Date.now;
  const tg = tgFor(d, clock);
  if (!tg) return { event: 'send', counts: {}, exitCode: 0 };
  const counts: Counts = {};
  try {
    const pending = await d.repo.tgPending(d.now());
    if (!pending.length) return { event: 'send', counts: { pending: 0 }, exitCode: 0 };
    // An unusable snapshot answers without levels: no stored hysteresis needed.
    const states = snap.ok ? await d.repo.pointStates([...new Set(pending.map((q) => q.k))]) : {};
    await answerPending(d.repo, pending, snap, new Map(), (k) => states[k], tg, newPushRun(clock() + SEND_BUDGET_MS, clock), CAPS.tgPerRun, false, counts, () => d.stopping?.() === true);
    return { event: 'send', counts, exitCode: 0 };
  } catch (err) {
    return failed(err, counts);
  }
}
