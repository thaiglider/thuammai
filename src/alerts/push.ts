import { createECDH, createHash } from 'node:crypto';
import { PUSH_TTL_S } from '../core/alert-config';
import { PUSH_PAYLOAD_MAX_BYTES, pushPayload } from '../core/alert-text';
import { isAllowedPushEndpoint } from '../core/push-endpoint';
import type { Counts } from './log';
import type { Planned } from './plan';

export interface Vapid { subject: string; publicKey: string; privateKey: string }
export interface PushSubscriptionJson { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushOptions { TTL: number; urgency: 'high' | 'normal'; topic: string; timeout: number; vapidDetails: Vapid }
/** web-push's sendNotification: resolves on 2xx, rejects with a WebPushError (statusCode, headers). */
export type SendNotification = (sub: PushSubscriptionJson, payload: string, opts: PushOptions) => Promise<{ statusCode: number }>;

/** Same key → same Topic, so a newer message for a place replaces one still queued (spec §5.4). */
export const pushTopic = (key: string): string => createHash('sha256').update(key).digest('base64url').slice(0, 32);

type Outcome = 'ok' | 'dead' | 'bad' | 'invalid' | 'auth' | 'retry' | 'blocked' | 'oversize';

/** Run-wide push state shared by every batch of one run (C1, m8). */
export interface PushRun {
  ok: number;
  auth: number;
  /** Targets that answered 401/403: deleted only once some send of this run succeeded, which
   *  proves our own VAPID keys work (so the 401/403 was about that subscription). */
  pendingAuth: number[];
  stopped: boolean;
  timedOut: boolean;
  deadline: number;
  clock: () => number;
}
/** ≥ this many 401/403 and not one success in the run → it is our VAPID config, not the
 *  subscriptions: stop the run's pushes and delete nothing. */
export const AUTH_STOP_AFTER = 3;
export const newPushRun = (deadline = Infinity, clock: () => number = Date.now): PushRun =>
  ({ ok: 0, auth: 0, pendingAuth: [], stopped: false, timedOut: false, deadline, clock });

const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
/** The same checks web-push makes before encrypting (plus a real P-256 point check): a failure
 *  here is about this subscription only, never about our config. */
export function subscriptionKeysOk(p256dh: string, auth: string): boolean {
  if (!B64URL_RE.test(p256dh) || !B64URL_RE.test(auth)) return false;
  const pk = Buffer.from(p256dh, 'base64url');
  if (pk.length !== 65 || pk[0] !== 4 || Buffer.from(auth, 'base64url').length < 16) return false;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(pk);
    return true;
  } catch {
    return false;
  }
}

function failure(e: unknown): { status: number | null; retryAfterS: number } {
  const x = e as { statusCode?: unknown; headers?: Record<string, unknown> } | null;
  const ra = Number(x?.headers?.['retry-after']);
  return { status: typeof x?.statusCode === 'number' ? x.statusCode : null, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : 1 };
}

/** Send one batch (spec §5.5): ≤`concurrency` in flight, allowlist re-checked, errors mapped to
 *  outcomes. Only `ok` items may be recorded as sent.
 *  - 404/410: the subscription is gone → dead.
 *  - 400/413 and keys that fail local validation → dead too (m1). Tradeoff: a bug of ours that
 *    made every request malformed would delete targets; but a kept target would be retried every
 *    run forever (a 1 s sleep and a cap slot each), and a malformed payload of ours is caught
 *    before sending (`oversize`), so a 400 here is almost always about that subscription.
 *  - 401/403: VAPID mismatch for THAT subscription (e.g. made with another key, or before a key
 *    rotation) → dead, but only once the run has a success. `AUTH_STOP_AFTER` of them with no
 *    success at all (checked after the sends in flight settle) → our VAPID is wrong → stop. */
export async function sendPush(items: Planned[], gen: string, send: SendNotification, vapid: Vapid, sleep: (ms: number) => Promise<void>, concurrency = 50, run: PushRun = newPushRun()): Promise<{ ok: Planned[]; dead: number[]; counts: Counts }> {
  const counts = { push_ok: 0, push_dead: 0, push_bad: 0, push_invalid: 0, push_auth: 0, push_deferred: 0, push_blocked: 0, push_oversize: 0 };
  const ok: Planned[] = [];
  const dead = new Set<number>();
  let next = 0;
  let inflight = 0;
  let idle: (() => void)[] = [];
  const settle = () => { if (inflight === 0) { const w = idle; idle = []; for (const f of w) f(); } };
  const suspectConfig = () => run.auth >= AUTH_STOP_AFTER && run.ok === 0;

  const one = async (p: Planned): Promise<Outcome> => {
    const { endpoint, p256dh, auth, key } = p.f;
    if (!p.msg || !endpoint || !p256dh || !auth || !isAllowedPushEndpoint(endpoint)) return 'blocked';
    if (!subscriptionKeysOk(p256dh, auth)) return 'invalid';
    const payload = pushPayload(p.msg, key, gen);
    if (Buffer.byteLength(payload, 'utf8') > PUSH_PAYLOAD_MAX_BYTES) return 'oversize';
    const clear = p.kind === 'clear';
    // Own Topic: a trend must never replace a queued level alert for the same place.
    const trend = p.msg.kind === 'trend';
    const opts: PushOptions = { TTL: clear ? PUSH_TTL_S.clear : trend ? PUSH_TTL_S.trend : PUSH_TTL_S.alert, urgency: clear || trend ? 'normal' : 'high', topic: pushTopic(trend ? `${key}|trend` : key), timeout: 10_000, vapidDetails: vapid };
    for (let attempt = 0; attempt < 2; attempt++) {
      let status: number | null;
      let retryAfterS = 1;
      try {
        status = (await send({ endpoint, keys: { p256dh, auth } }, payload, opts)).statusCode;
      } catch (e) {
        ({ status, retryAfterS } = failure(e));
      }
      if (status !== null && status >= 200 && status < 300) return 'ok';
      if (status === 404 || status === 410) return 'dead';
      if (status === 400 || status === 413) return 'bad';
      if (status === 401 || status === 403) return 'auth';
      if (attempt === 0) await sleep(Math.min(retryAfterS, 10) * 1000);
    }
    return 'retry';
  };

  const lane = async (): Promise<void> => {
    while (next < items.length) {
      if (!run.stopped && suspectConfig() && inflight > 0) {
        // Wait for the sends in flight: one success among them proves our VAPID works.
        await new Promise<void>((res) => idle.push(res));
        continue;
      }
      if (!run.stopped && suspectConfig()) run.stopped = true;
      if (!run.timedOut && run.clock() >= run.deadline) run.timedOut = true;
      const p = items[next++]!;
      if (run.stopped || run.timedOut) { counts.push_deferred++; continue; }
      inflight++;
      let r: Outcome;
      try {
        r = await one(p);
      } finally {
        inflight--;
      }
      if (r === 'ok') { counts.push_ok++; run.ok++; ok.push(p); }
      else if (r === 'dead') { counts.push_dead++; dead.add(p.f.targetId); }
      else if (r === 'bad') { counts.push_bad++; dead.add(p.f.targetId); }
      else if (r === 'invalid') { counts.push_invalid++; dead.add(p.f.targetId); }
      else if (r === 'blocked') counts.push_blocked++;
      else if (r === 'oversize') counts.push_oversize++;
      else if (r === 'auth') { counts.push_auth++; run.auth++; run.pendingAuth.push(p.f.targetId); }
      else counts.push_deferred++;
      settle();
    }
    settle();
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
  if (run.ok > 0) {
    for (const t of run.pendingAuth) dead.add(t);
    run.pendingAuth = [];
  }
  return { ok, dead: [...dead], counts };
}
