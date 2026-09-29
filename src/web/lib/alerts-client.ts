import { alertKey } from '../../core/alert-key';
import { clearAlertPlaces, writeAlertPlaces } from './alert-places';
import { alertsCfg, clearAlerts, loadAlerts, placesHash, pushConfigured, saveAlerts, type AlertsCfg } from './alerts-state';
import type { Place } from './places';
import type { KV } from './storage';

export interface SubLike { endpoint: string; toJSON(): { endpoint?: string; keys?: Record<string, string> }; unsubscribe(): Promise<boolean> }
export interface PushManagerLike {
  getSubscription(): Promise<SubLike | null>;
  subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<SubLike>;
}
export interface PushDeps {
  cfg: AlertsCfg; kv: KV; base: string; fetch: typeof fetch; now(): Date;
  /** Waits for an active service worker (to subscribe). */
  pushManager(): Promise<PushManagerLike>;
  /** The existing registration's push manager, without waiting; null = no service worker
   *  registered (it was removed, e.g. by swKill) — then no subscription can exist. */
  registeredPushManager(): Promise<PushManagerLike | null>;
  requestPermission(): Promise<string>;
  caches: CacheStorage | null; timeoutMs?: number;
}
export type EnableResult = 'ok' | 'denied' | 'browser' | 'unavailable' | 'rate' | 'limited' | 'full';
/** `paused`: local state is on but nothing can be delivered (I3); `limited`: the Worker's per-day
 *  new-places cap — no retry before the next UTC day (m4). */
export type SyncResult = 'off' | 'unchanged' | 'ok' | 'failed' | 'removed' | 'revoked' | 'paused' | 'limited';

const WEEK_MS = 7 * 86400e3;

export function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** What the server gets: ~100 m points, de-duplicated, never a name (spec §8). */
export function serverPlaces(places: readonly Place[]): { lat: number; lon: number }[] {
  const out = new Map<string, { lat: number; lon: number }>();
  for (const p of places) {
    const k = alertKey(p.lat, p.lon);
    if (out.has(k)) continue;
    const [lat, lon] = k.split(',').map(Number) as [number, number];
    out.set(k, { lat, lon });
  }
  return [...out.values()];
}

/** Next 00:00 UTC — the Worker's day for its per-target new-places counter. */
export function nextUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}
const tooManyPlaces = (r: { status: number; code: string | null }) => r.status === 429 && r.code === 'too_many_places';

async function call(d: PushDeps, method: 'POST' | 'DELETE', body: unknown): Promise<{ status: number; code: string | null }> {
  // Never a request to a relative or empty origin (alerts off in this build).
  if (!pushConfigured(d.cfg)) return { status: 0, code: null };
  try {
    const res = await d.fetch(`${d.cfg.origin}/v1/push/subscription`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(d.timeoutMs ?? 10_000),
    });
    let code: string | null = null;
    if (!res.ok) { try { code = ((await res.json()) as { error?: string }).error ?? null; } catch { /* no body */ } }
    return { status: res.status, code };
  } catch {
    return { status: 0, code: null };
  }
}

function keysOf(sub: SubLike): { p256dh: string; auth: string } | null {
  const k = sub.toJSON().keys;
  return k && typeof k.p256dh === 'string' && typeof k.auth === 'string' ? { p256dh: k.p256dh, auth: k.auth } : null;
}
function post(d: PushDeps, sub: SubLike, places: readonly Place[]) {
  const keys = keysOf(sub);
  return keys ? call(d, 'POST', { endpoint: sub.endpoint, keys, places: serverPlaces(places) }) : Promise.resolve({ status: 0, code: null });
}
async function forget(d: PushDeps, sub: SubLike | null): Promise<void> {
  if (sub) {
    const keys = keysOf(sub);
    if (keys) await call(d, 'DELETE', { endpoint: sub.endpoint, auth: keys.auth }); // failure is fine: 404/410 cleans the server
    await sub.unsubscribe().catch(() => false);
  }
  clearAlerts(d.kv);
  await clearAlertPlaces(d.caches);
}

/** Spec §6.1 steps 2–5. Must be called straight from the tap handler: the permission request is
 *  its first, synchronous step (iOS requires a user gesture). */
export async function enableAlerts(d: PushDeps, places: readonly Place[]): Promise<EnableResult> {
  let perm: string;
  try { perm = await d.requestPermission(); } catch { perm = 'denied'; }
  if (perm !== 'granted') return 'denied';
  let pm: PushManagerLike;
  let sub: SubLike;
  const subscribe = () => pm.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(d.cfg.vapid) });
  try {
    pm = await d.pushManager();
    sub = await subscribe();
  } catch {
    return 'browser';
  }
  for (let attempt = 0; ; attempt++) {
    const r = await post(d, sub, places);
    if (r.status === 200) {
      saveAlerts(d.kv, { on: true, endpoint: sub.endpoint, syncedAt: d.now().toISOString(), placesHash: placesHash(places), origin: d.cfg.origin });
      await writeAlertPlaces(d.caches, d.base, places);
      return 'ok';
    }
    await sub.unsubscribe().catch(() => false); // never leave a half-made subscription
    if (r.status === 409 && attempt === 0) {
      try { sub = await subscribe(); } catch { return 'browser'; }
      continue;
    }
    if (tooManyPlaces(r)) return 'limited';
    if (r.status === 429) return 'rate';
    if (r.status === 503 && r.code === 'full') return 'full';
    return 'unavailable';
  }
}

/** Spec §6.2: keep the server's set equal to the saved places. */
export async function syncNow(d: PushDeps, places: readonly Place[]): Promise<SyncResult> {
  const st = loadAlerts(d.kv);
  if (!st) return 'off';
  if (!pushConfigured(d.cfg)) return 'paused';
  let pm: PushManagerLike | null;
  try { pm = await d.registeredPushManager(); } catch {
    saveAlerts(d.kv, { ...st, pending: true });
    return 'failed';
  }
  if (!pm) return 'paused';
  const sub = await pm.getSubscription().catch(() => null);
  if (!sub) { clearAlerts(d.kv); await clearAlertPlaces(d.caches); return 'revoked'; }
  if (!places.length) { await forget(d, sub); return 'removed'; }
  await writeAlertPlaces(d.caches, d.base, places);
  const hash = placesHash(places);
  const fresh = d.now().getTime() - Date.parse(st.syncedAt) < WEEK_MS;
  if (!st.pending && hash === st.placesHash && sub.endpoint === st.endpoint && fresh && st.origin === d.cfg.origin) return 'unchanged';
  if (st.holdUntil && d.now().getTime() < Date.parse(st.holdUntil)) return 'limited';
  const r = await post(d, sub, places);
  if (r.status === 200) {
    saveAlerts(d.kv, { on: true, endpoint: sub.endpoint, syncedAt: d.now().toISOString(), placesHash: hash, origin: d.cfg.origin });
    return 'ok';
  }
  if (tooManyPlaces(r)) {
    saveAlerts(d.kv, { ...st, pending: true, holdUntil: nextUtcDay(d.now()) });
    return 'limited';
  }
  saveAlerts(d.kv, { ...st, pending: true });
  return 'failed';
}

async function currentSub(d: PushDeps): Promise<SubLike | null> {
  try { return (await (await d.registeredPushManager())?.getSubscription()) ?? null; } catch { return null; }
}

/** true when no service worker is registered, so no push can arrive (I3). */
export async function serviceWorkerGone(d: PushDeps): Promise<boolean> {
  try { return (await d.registeredPushManager()) === null; } catch { return false; }
}

/** เมนู → "เลิกรับแจ้งเตือน" (spec §6.5), and "ลบการตั้งค่า" in the paused state. */
export async function disableAlerts(d: PushDeps): Promise<void> {
  await forget(d, await currentSub(d));
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** Debounced sync after a place edit (spec §6.2: 2 s). */
export function scheduleSync(d: PushDeps, getPlaces: () => Place[], done: (r: SyncResult) => void, delayMs = 2000): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncNow(d, getPlaces()).then(done);
  }, delayMs);
}

export function browserPushDeps(kv: KV, base: string): PushDeps {
  return {
    cfg: alertsCfg(), kv, base, now: () => new Date(),
    fetch: (input, init) => fetch(input, init),
    pushManager: async () => {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('service worker not ready')), 10_000)),
      ]);
      return reg.pushManager as unknown as PushManagerLike;
    },
    registeredPushManager: async () => {
      if (!('serviceWorker' in navigator)) return null;
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? (reg.pushManager as unknown as PushManagerLike) : null;
    },
    requestPermission: () => Notification.requestPermission(),
    caches: typeof caches !== 'undefined' ? caches : null,
  };
}

export type ServerStatus = 'on' | 'paused' | 'down';
export const STATUS_EVERY_MS = 10 * 60_000;
export const STATUS_RETRY_MS = 60_000;
export const STATUS_MAX_PER_WINDOW = 2;

/** GET /v1/status (spec §8.1): 'down' when the server says it is stalled; null when the request
 *  failed (network, timeout, 5xx, bad JSON). Never called without an alerts configuration. */
export async function checkStatus(d: Pick<PushDeps, 'cfg' | 'fetch'>, timeoutMs = 5_000): Promise<ServerStatus | null> {
  if (!pushConfigured(d.cfg)) return null;
  try {
    const r = await d.fetch(`${d.cfg.origin}/v1/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const a = ((await r.json()) as { alerts?: unknown }).alerts;
    return a === 'on' ? 'on' : a === 'paused' ? 'paused' : a === 'stalled' ? 'down' : null;
  } catch {
    return null;
  }
}

export interface StatusTimers { now(): number; later(fn: () => void, ms: number): void }
const REAL_TIMERS: StatusTimers = { now: () => Date.now(), later: (fn, ms) => { setTimeout(fn, ms); } };

/** R13: at most one check per 10 minutes (plus one retry 60 s after a failure), never more than 2
 *  requests per 10 minutes in this tab; results live only in memory. A second failure → 'down'. */
export function statusMonitor(d: Pick<PushDeps, 'cfg' | 'fetch'>, onChange: (s: ServerStatus) => void, t: StatusTimers = REAL_TIMERS): { maybeCheck(): void } {
  let last = -Infinity;
  let retrying = false;
  const sent: number[] = [];
  const budget = (): boolean => {
    const now = t.now();
    while (sent.length && now - sent[0]! >= STATUS_EVERY_MS) sent.shift();
    return sent.length < STATUS_MAX_PER_WINDOW;
  };
  const attempt = async (isRetry: boolean): Promise<void> => {
    if (!budget()) { retrying = false; return; }
    sent.push(t.now());
    last = t.now();
    const s = await checkStatus(d);
    if (s) { retrying = false; onChange(s); return; }
    if (isRetry) { retrying = false; onChange('down'); return; }
    retrying = true;
    t.later(() => { void attempt(true); }, STATUS_RETRY_MS);
  };
  return {
    maybeCheck(): void {
      if (retrying || t.now() - last < STATUS_EVERY_MS) return;
      void attempt(false);
    },
  };
}
