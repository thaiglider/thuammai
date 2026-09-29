import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { LINE_LOCATION_BUTTON_TH } from '../core/line-text';

/* LINE Messaging API (phase-3C spec §2.2 F2–F10). Driver-free so both the api (webhook, admin) and
 * alerts (answers, pushes) use it (G-1). Returns HTTP statuses only — 0 for a network error or a
 * timeout — and never throws: nothing here can put a token, a user id or a reply token in a log. */

export const LINE_API = 'https://api.line.me';
export const USER_ID_RE = /^U[0-9a-f]{32}$/;

export type LineAction = { type: 'postback'; label: string; data: string; displayText?: string } | { type: 'location'; label: string };
export interface LineText { type: 'text'; text: string; quickReply?: { items: { type: 'action'; action: LineAction }[] } }

export const quickReply = (actions: LineAction[]): NonNullable<LineText['quickReply']> => ({ items: actions.map((action) => ({ type: 'action' as const, action })) });
/** The quick-reply button that opens LINE's location picker (iOS/Android only, F10). */
export const LOCATION_ACTION: LineAction = { type: 'location', label: LINE_LOCATION_BUTTON_TH };
export const textMsg = (text: string, actions?: LineAction[]): LineText => (actions?.length ? { type: 'text', text, quickReply: quickReply(actions) } : { type: 'text', text });

/** F6: x-line-signature = Base64(HMAC-SHA256(channel secret, raw body)); compared in constant time
 *  (both sides hashed first, so their lengths never matter). */
export function lineSignatureOk(secret: string, body: Uint8Array, header: string | null): boolean {
  if (!header) return false;
  const want = createHmac('sha256', secret).update(body).digest('base64');
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(want), h(header));
}

/** RFC 4122 URL namespace — our retry keys are names inside it. */
export const LINE_RETRY_NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
/** RFC 4122 §4.3 name-based UUID, version 5 (SHA-1) — node:crypto has randomUUID only (G-2). */
export function uuidV5(name: string, namespace: string = LINE_RETRY_NS): string {
  const b = createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
/** X-Line-Retry-Key of one push (spec §5.3, F7): the same person, gen and (follow, kind) set after a
 *  restart mid-run → the same key → LINE answers 409 and counts nothing twice. */
export function lineRetryKey(user: string, gen: string, items: readonly { fid: number; kind: string }[]): string {
  const list = [...items].sort((a, b) => a.fid - b.fid).map((i) => `${i.fid}:${i.kind}`).join(',');
  return uuidV5(`${user}|${gen}|${list}`);
}

export interface LineApi {
  reply(token: string, messages: LineText[]): Promise<number>;
  push(to: string, messages: LineText[], retryKey: string): Promise<number>;
  /** F8: the monthly target; null for "none" or when LINE did not answer. */
  quota(): Promise<{ status: number; limit: number | null }>;
  /** F8: messages sent this month as LINE counts them. */
  consumption(): Promise<{ status: number; total: number | null }>;
  /** The display name right now (sent to the admin once, never stored — R-L9); null on any failure. */
  profileName(user: string): Promise<string | null>;
}

export function lineApi(token: string, fetchImpl: typeof fetch, timeoutMs = 10_000): LineApi {
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> | null }> => {
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extra };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetchImpl(`${LINE_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      let json: Record<string, unknown> | null = null;
      try { json = (await r.json()) as Record<string, unknown>; } catch { json = null; }
      return { status: r.status, json };
    } catch {
      return { status: 0, json: null };
    }
  };
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  return {
    reply: async (replyToken, messages) => (await call('POST', '/v2/bot/message/reply', { replyToken, messages })).status,
    push: async (to, messages, retryKey) => (await call('POST', '/v2/bot/message/push', { to, messages }, { 'x-line-retry-key': retryKey })).status,
    quota: async () => {
      const r = await call('GET', '/v2/bot/message/quota');
      return { status: r.status, limit: r.status === 200 && r.json?.type === 'limited' ? num(r.json.value) : null };
    },
    consumption: async () => {
      const r = await call('GET', '/v2/bot/message/quota/consumption');
      return { status: r.status, total: r.status === 200 ? num(r.json?.totalUsage) : null };
    },
    profileName: async (user) => {
      if (!USER_ID_RE.test(user)) return null;
      const r = await call('GET', `/v2/bot/profile/${user}`);
      return r.status === 200 && typeof r.json?.displayName === 'string' ? r.json.displayName : null;
    },
  };
}
