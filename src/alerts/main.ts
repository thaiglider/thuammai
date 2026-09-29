import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import webpush from 'web-push';
import { ALERTS_ORIGIN_RE, CAPS } from '../core/alert-config';
import type { FollowState } from '../core/alert-rule';
import type { ProvinceGeo } from '../core/types';
import { errorCounts, logCounts, type Counts, type LogEvent } from './log';
import { capPlanned, evaluatePoints, keysToQuery, mergeForRetry, packBlob, parseBlob, planFollows, recomputeEp, toUpdate, type Planned } from './plan';
import { newPushRun, sendPush, type PushRun, type SendNotification, type Vapid } from './push';
import { loadProvinces, loadSnapshot } from './snapshot';
import { WorkerError, workerClient, type FollowRow, type WorkerClient } from './worker-client';

/** Telegram sending arrives with Plan E; Telegram follows are deferred (not sent, not recorded). */
export const CHANNELS = { push: true, tg: false } as const;

export interface AlertEnv { ALERTS_ORIGIN?: string; ALERTS_API_TOKEN?: string; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
export interface AlertDeps {
  env: AlertEnv; dataDir: string; provinces: ProvinceGeo[];
  now(): Date; fetch: typeof fetch; sendNotification: SendNotification; sleep(ms: number): Promise<void>;
  /** Wall clock for the send deadline (default Date.now). */
  clock?(): number;
}
/** No new push starts after this long from the start of the run (m8): the job times out at 8 min
 *  (setup takes ~1 min), and a send in flight can take ~30 s more, so the state PUT always runs. */
export const SEND_BUDGET_MS = 5 * 60_000;

export interface RunResult { event: LogEvent; counts: Counts; exitCode: number }

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
  const client = workerClient(e.ALERTS_ORIGIN, e.ALERTS_API_TOKEN, d.fetch);
  if (!(await client.health())) return { event: 'skip', counts: { worker_unreachable: 1 }, exitCode: 0 };
  try {
    return await runWith(client, d, { subject: e.VAPID_SUBJECT, publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY }, newPushRun(deadline, clock));
  } catch (err) {
    if (err instanceof WorkerError && err.status === 0) return { event: 'skip', counts: { worker_unreachable: 1 }, exitCode: 0 };
    if (err instanceof WorkerError && err.code === 'not_configured') return { event: 'error', counts: { worker_not_configured: 1 }, exitCode: 1 };
    if (err instanceof WorkerError && err.status === 503) return { event: 'skip', counts: { d1_quota: 1 }, exitCode: 0 };
    return { event: 'error', counts: errorCounts(err), exitCode: 1 };
  }
}

async function runWith(client: WorkerClient, d: AlertDeps, vapid: Vapid, run: PushRun): Promise<RunResult> {
  const started = Date.now();
  const snap = loadSnapshot(d.dataDir, d.provinces, d.now());
  const places = await client.places();
  const state = await client.getState();
  const prev = parseBlob(state.value);
  const counts: Counts = { places: places.length };
  if (!snap.ok) counts[`snapshot_${snap.reason}`] = 1;
  if (snap.ok && prev && Date.parse(snap.gen) <= Date.parse(prev.gen)) {
    return { event: 'skip', counts: { ...counts, not_newer: 1 }, exitCode: 0 };
  }

  const ev = evaluatePoints(snap, places, prev);
  add(counts, ev.counts);
  const queried = keysToQuery(ev.points, snap.gen);
  const follows: FollowRow[] = await client.targets(queried);
  const planned = planFollows(follows, ev.points, snap.gen);
  const capped = capPlanned(planned, { push: CAPS.pushPerRun, tg: CAPS.tgPerRun }, CHANNELS);
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

  if (run.stopped) counts.push_stopped = 1;
  if (run.timedOut) counts.send_deadline = 1;

  recomputeEp(ev.blob, queried, follows, written);
  let version = await client.putState(state.version, packBlob(ev.blob));
  if (version === null) {
    const again = await client.getState();
    const merged = mergeForRetry(parseBlob(again.value), ev.blob);
    version = merged ? await client.putState(again.version, packBlob(merged)) : null;
    if (version === null) counts.state_conflict = 1;
  }
  counts.ms = Date.now() - started;
  return { event: 'run', counts, exitCode: 0 };
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
