import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import webpush from 'web-push';
import { ALERTS_ORIGIN_RE, CAPS } from '../core/alert-config';
import type { FollowState } from '../core/alert-rule';
import { alertShown } from '../core/hysteresis';
import { assessPoint } from '../core/risk';
import { pointReplyText, siteLink, tgAlertText } from '../core/tg-text';
import type { Level, ProvinceGeo } from '../core/types';
import { errorCounts, logCounts, type Counts, type LogEvent } from './log';
import { capPlanned, evaluatePoints, keysToQuery, mergeForRetry, packBlob, parseBlob, planFollows, recomputeEp, toUpdate, type AlertStateBlob, type Planned, type PointEval } from './plan';
import { newPushRun, sendPush, type PushRun, type SendNotification, type Vapid } from './push';
import { inputAt, loadProvinces, loadSnapshot, type Snapshot } from './snapshot';
import { sendTelegram, tgSender, type Clock, type TgSend } from './telegram';
import { WorkerError, workerClient, type FollowRow, type PendingRow, type WorkerClient } from './worker-client';

export interface AlertEnv {
  ALERTS_ORIGIN?: string; ALERTS_API_TOKEN?: string; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string;
  /** Telegram is on only when both are set; otherwise Telegram follows are deferred (not sent, not recorded). */
  TELEGRAM_BOT_TOKEN?: string; SITE_URL?: string;
}
export interface AlertDeps {
  env: AlertEnv; dataDir: string; provinces: ProvinceGeo[];
  now(): Date; fetch: typeof fetch; sendNotification: SendNotification; sleep(ms: number): Promise<void>;
  /** Wall clock for the send deadline and the Telegram pacing (default Date.now). */
  clock?(): number;
  /** Tests inject the Bot API; the CLI builds it from TELEGRAM_BOT_TOKEN. */
  tgSend?: TgSend;
}
/** No new push starts after this long from the start of the run (m8): the job times out at 8 min
 *  (setup takes ~1 min), and a send in flight can take ~30 s more, so the state PUT always runs. */
export const SEND_BUDGET_MS = 5 * 60_000;

export interface RunResult { event: LogEvent; counts: Counts; exitCode: number }
/** Telegram for this run; its clock is the run's clock, so there is one send deadline. */
interface Tg { send: TgSend; site: string; clock: Clock }

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const add = (counts: Counts, more: Counts) => { for (const [k, v] of Object.entries(more)) counts[k] = (counts[k] ?? 0) + v; };

/** One alerts run (spec §5.1). Never throws; the caller prints one logCounts line. */
export async function runAlerts(d: AlertDeps): Promise<RunResult> {
  const e = d.env;
  const clock = d.clock ?? Date.now;
  const deadline = clock() + SEND_BUDGET_MS;
  if (!e.ALERTS_ORIGIN || !e.ALERTS_API_TOKEN || !e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY || !e.VAPID_SUBJECT) {
    return { event: 'error', counts: { config_missing: 1 }, exitCode: 1 };
  }
  // The site build only warns about a bad origin (I2); this job is where it fails loudly.
  if (!ALERTS_ORIGIN_RE.test(e.ALERTS_ORIGIN)) return { event: 'error', counts: { config_invalid_origin: 1 }, exitCode: 1 };
  // Links need the site URL (ruling 12: always with a trailing slash).
  const tg: Tg | null = e.TELEGRAM_BOT_TOKEN && e.SITE_URL
    ? { send: d.tgSend ?? tgSender(e.TELEGRAM_BOT_TOKEN, d.fetch), site: e.SITE_URL.endsWith('/') ? e.SITE_URL : `${e.SITE_URL}/`, clock: { now: clock, sleep: d.sleep } }
    : null;
  const client = workerClient(e.ALERTS_ORIGIN, e.ALERTS_API_TOKEN, d.fetch);
  if (!(await client.health())) return { event: 'skip', counts: { worker_unreachable: 1 }, exitCode: 0 };
  try {
    return await runWith(client, d, { subject: e.VAPID_SUBJECT, publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY }, newPushRun(deadline, clock), tg);
  } catch (err) {
    if (err instanceof WorkerError && err.status === 0) return { event: 'skip', counts: { worker_unreachable: 1 }, exitCode: 0 };
    if (err instanceof WorkerError && err.code === 'not_configured') return { event: 'error', counts: { worker_not_configured: 1 }, exitCode: 1 };
    if (err instanceof WorkerError && err.status === 503) return { event: 'skip', counts: { d1_quota: 1 }, exitCode: 0 };
    return { event: 'error', counts: errorCounts(err), exitCode: 1 };
  }
}

async function runWith(client: WorkerClient, d: AlertDeps, vapid: Vapid, run: PushRun, tg: Tg | null): Promise<RunResult> {
  const started = Date.now();
  const snap = loadSnapshot(d.dataDir, d.provinces, d.now());
  const places = await client.places();
  const state = await client.getState();
  const prev = parseBlob(state.value);
  const counts: Counts = { places: places.length };
  if (!snap.ok) counts[`snapshot_${snap.reason}`] = 1;
  if (snap.ok && prev && Date.parse(snap.gen) <= Date.parse(prev.gen)) {
    // No alerts from a snapshot already evaluated (D2), but questions are still answered (E11).
    counts.not_newer = 1;
    const failed = tg ? await answerPendingSafe(client, snap, new Map(), prev, tg, run, CAPS.tgPerRun, false, counts) : null;
    if (run.timedOut) counts.send_deadline = 1;
    return failed ?? { event: 'skip', counts, exitCode: 0 };
  }

  const ev = evaluatePoints(snap, places, prev);
  add(counts, ev.counts);
  const queried = keysToQuery(ev.points, snap.gen);
  const follows: FollowRow[] = await client.targets(queried);
  const planned = planFollows(follows, ev.points, snap.gen);
  const capped = capPlanned(planned, { push: CAPS.pushPerRun, tg: CAPS.tgPerRun }, { push: true, tg: tg !== null });
  for (const p of capped.send) counts[p.kind!] = (counts[p.kind!] ?? 0) + 1;
  counts.deferred = capped.deferred;

  const written = new Map<number, FollowState>();
  const record = (ps: Planned[]) => { for (const p of ps) written.set(p.f.fid, p.next); };
  // State-only changes (e.g. alerted 4 → 3) need no message.
  for (const c of chunks(capped.stateOnly, CAPS.batch)) {
    await client.report({ follows: c.map(toUpdate), deadTargets: [], donePending: [] });
    record(c);
  }
  // Send, then record (at-least-once): a failed report can repeat at most this one batch.
  // `run` spans the batches: the VAPID-misconfiguration stop and the send deadline (C1, m8).
  for (const c of chunks(capped.send.filter((p) => p.f.ch === 'push'), CAPS.batch)) {
    if (!run.timedOut && run.clock() >= run.deadline) run.timedOut = true;
    if (run.stopped || run.timedOut) { counts.push_deferred = (counts.push_deferred ?? 0) + c.length; continue; }
    const out = await sendPush(c, snap.gen, d.sendNotification, vapid, d.sleep, 50, run);
    add(counts, out.counts);
    if (out.ok.length || out.dead.length) {
      await client.report({ follows: out.ok.map(toUpdate), deadTargets: out.dead, donePending: [] });
      record(out.ok);
    }
  }

  // Telegram after push, same priority order (spec §5.1 step 6) and same send deadline; the VAPID
  // stop is about push only. Deferred items are not recorded, so the next run re-evaluates them.
  let tgUsed = 0;
  // A 429 stop or a wrong token (401) stops Telegram for the whole run, pending answers included.
  let tgStopped = false;
  if (tg) {
    for (const c of chunks(capped.send.filter((p) => p.f.ch === 'tg' && p.f.chat !== null && p.msg !== null), CAPS.batch)) {
      if (!run.timedOut && run.clock() >= run.deadline) run.timedOut = true;
      if (tgStopped || run.timedOut) { counts.tg_deferred = (counts.tg_deferred ?? 0) + c.length; continue; }
      const out = await sendTelegram(c.map((p) => ({ chat: p.f.chat!, text: tgAlertText(p.f.label ?? 'จุดที่ติดตาม', p.msg!, siteLink(tg.site, p.f.key)), ref: p })), tg.send, tg.clock, run.deadline);
      tgUsed += c.length;
      add(counts, out.counts);
      tgStopped = out.stopped;
      if (out.stopped && run.clock() >= run.deadline) run.timedOut = true;
      if (out.ok.length || out.dead.length) {
        await client.report({ follows: out.ok.map(toUpdate), deadTargets: [...new Set(out.dead.map((p) => p.f.targetId))], donePending: [] });
        record(out.ok);
      }
    }
  }

  if (run.stopped) counts.push_stopped = 1;

  recomputeEp(ev.blob, queried, follows, written);
  let version = await client.putState(state.version, packBlob(ev.blob));
  if (version === null) {
    const again = await client.getState();
    const merged = mergeForRetry(parseBlob(again.value), ev.blob);
    version = merged ? await client.putState(again.version, packBlob(merged)) : null;
    if (version === null) counts.state_conflict = 1;
  }
  // Questions from the bot are answered every run, honestly, even when alerts stay silent (E11).
  const failed = tg ? await answerPendingSafe(client, snap, ev.points, prev, tg, run, CAPS.tgPerRun - tgUsed, tgStopped, counts) : null;
  if (run.timedOut) counts.send_deadline = 1;
  counts.ms = Date.now() - started;
  return failed ?? { event: 'run', counts, exitCode: 0 };
}

/** answerPending runs after the state is written, so its failure must not lose the run's counts
 *  (final review M9): `pending_error=1` plus the counts so far. The Worker unreachable or at its D1
 *  quota is not an error (D9) — the questions stay queued for the next run; anything else is. */
async function answerPendingSafe(client: WorkerClient, snap: Snapshot, points: Map<string, PointEval>, prev: AlertStateBlob | null, tg: Tg, run: PushRun, budget: number, stopped: boolean, counts: Counts): Promise<RunResult | null> {
  try {
    await answerPending(client, snap, points, prev, tg, run, budget, stopped, counts);
    return null;
  } catch (err) {
    counts.pending_error = 1;
    if (err instanceof WorkerError && (err.status === 0 || err.status === 503)) return null;
    return { event: 'error', counts: { ...counts, ...errorCounts(err) }, exitCode: 1 };
  }
}

/** The point's level as the card would show it (E10): this run's hysteresis for an evaluated
 *  place, else the stored one, else the raw level. */
function pendingText(q: PendingRow, snap: Snapshot, points: Map<string, PointEval>, prev: AlertStateBlob | null, site: string): string {
  const link = siteLink(site, q.k);
  if (!snap.ok) return pointReplyText({ unusable: true, gen: snap.gen || null }, link);
  const a = assessPoint(q.lat, q.lon, inputAt(snap, q.lat, q.lon));
  const stored = prev?.places[q.k];
  const shownNow = points.get(q.k)?.step.shown ?? (stored ? alertShown(stored, a.level, snap.gen).shown : null);
  const shown: Level = shownNow === 3 || shownNow === 4 ? shownNow : a.level;
  return pointReplyText({ shown, a, gen: snap.gen }, link);
}

/** Answer the queued questions within the Telegram budget and the run's send deadline. Answered
 *  and dead-chat questions are done; deferred ones stay queued for the next run. */
async function answerPending(client: WorkerClient, snap: Snapshot, points: Map<string, PointEval>, prev: AlertStateBlob | null, tg: Tg, run: PushRun, budget: number, stopped: boolean, counts: Counts): Promise<void> {
  const pending = await client.tgPending();
  counts.pending = pending.length;
  if (!pending.length) return;
  // Telegram already stopped this run (429 or 401): no further request, everything waits (M2).
  const now = stopped ? [] : pending.slice(0, Math.max(0, budget));
  const out = await sendTelegram(now.map((q) => ({ chat: q.chat, text: pendingText(q, snap, points, prev, tg.site), ref: q })), tg.send, tg.clock, run.deadline);
  if (out.stopped && run.clock() >= run.deadline) run.timedOut = true;
  const auth = out.counts.tg_auth ?? 0;
  if (auth) counts.tg_auth = (counts.tg_auth ?? 0) + auth;
  counts.pending_ok = out.counts.tg_ok ?? 0;
  counts.pending_dead = out.counts.tg_dead ?? 0;
  counts.pending_deferred = (out.counts.tg_deferred ?? 0) + auth + (pending.length - now.length);
  const done = [...out.ok, ...out.dead].map((q) => q.id);
  if (done.length) await client.report({ follows: [], deadTargets: [], donePending: done });
}

async function cli(): Promise<void> {
  const { values } = parseArgs({ options: { data: { type: 'string', default: '.cache/snapshot' } } });
  const r = await runAlerts({
    env: process.env, dataDir: values.data!, provinces: loadProvinces(),
    now: () => new Date(),
    fetch: (input, init) => fetch(input, init),
    sendNotification: (sub, payload, opts) => webpush.sendNotification(sub, payload, opts),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  });
  logCounts(r.event, r.counts);
  process.exitCode = r.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Last resort: even an unexpected crash prints counts only (never a stack with URLs in it).
  const fail = (e: unknown) => { logCounts('error', errorCounts(e)); process.exit(1); };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  cli().catch(fail);
}
