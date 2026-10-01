import type { TgInlineMarkup } from '../core/tg-text';
import type { Counts } from './log';

export interface TgSendResult { ok: boolean; status: number; retryAfterS: number; description: string }
export type TgSend = (chat: number, text: string, markup?: TgInlineMarkup) => Promise<TgSendResult>;
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export interface TgItem<T> {
  chat: number; text: string; ref: T; markup?: TgInlineMarkup;
  /** Sent once, without markup, when Telegram rejects the text itself (a 400 that is not a dead chat). */
  fallback?: string;
}

/** research §4: ~30/s overall and ~1/s per chat are community numbers, so we stay below them. */
export const TG_PACE = { perSecond: 25, perChatMs: 1000, maxRetryAfterS: 30 } as const;

/** sendMessage from the alerts job: plain text, no link preview; never throws; only the status,
 *  retry_after and description come back (nothing is logged by this module). */
export function tgSender(token: string, fetchImpl: typeof fetch, timeoutMs = 10_000): TgSend {
  return async (chat, text, markup) => {
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      type TgApiResponse = { ok?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };
      let j: TgApiResponse | null = null;
      try { j = (await r.json()) as TgApiResponse; } catch { j = null; }
      const retry = Number(j?.parameters?.retry_after);
      return { ok: r.ok && j?.ok === true, status: r.status, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 0, description: typeof j?.description === 'string' ? j.description : '' };
    } catch {
      return { ok: false, status: 0, retryAfterS: 0, description: '' };
    }
  };
}

/** Send in order (priority already applied), paced; spec §5.5 error handling.
 *  `deadline` (absolute `clock.now()` time, default none) is Task 7's hook for the run's send
 *  budget (Plan D `SEND_BUDGET_MS`, mirroring `PushRun.deadline` in push.ts): once reached, no
 *  further item is attempted and everything from that point on — including the one that would
 *  have run next — counts as `tg_deferred`, same as a second 429. Checked per item (not only
 *  between calls) so a caller can pass the whole queue in one `sendTelegram` call and still stop
 *  mid-queue at the deadline. A 429 wait that would end past the deadline is not taken (the item
 *  is deferred instead). A 401 means the bot token is wrong: `tg_auth`, and nothing more is sent
 *  (`stopped` and `auth`), like push's VAPID stop — no chat is ever treated as dead for it.
 *  A text Telegram rejects (a 400 that is not a dead chat) is sent once more as the item's
 *  `fallback`, without markup and at the same pace (`tg_fallback`); the item is then whatever that
 *  second send says, and a 429 there stops the rest like a second 429 (Plan O final review). */
export async function sendTelegram<T>(items: TgItem<T>[], send: TgSend, clock: Clock, deadline = Infinity): Promise<{ ok: T[]; dead: T[]; counts: Counts; stopped: boolean; auth: boolean }> {
  const counts: Counts = { tg_ok: 0, tg_dead: 0, tg_deferred: 0 };
  const ok: T[] = [];
  const dead: T[] = [];
  const lastByChat = new Map<number, number>();
  const gap = 1000 / TG_PACE.perSecond;
  let last = -Infinity;
  let waited429 = false;
  let stopped = false;
  let auth = false;
  const attempt = async (it: TgItem<T>): Promise<TgSendResult> => {
    const wait = Math.max(last + gap, (lastByChat.get(it.chat) ?? -Infinity) + TG_PACE.perChatMs) - clock.now();
    if (wait > 0) await clock.sleep(wait);
    const r = await send(it.chat, it.text, it.markup);
    last = clock.now();
    lastByChat.set(it.chat, last);
    return r;
  };
  for (const it of items) {
    if (!stopped && clock.now() >= deadline) stopped = true;
    if (stopped) { counts.tg_deferred++; continue; }
    let r = await attempt(it);
    if (r.status === 429) {
      const wait = Math.max(1, r.retryAfterS) * 1000;
      if (waited429 || r.retryAfterS > TG_PACE.maxRetryAfterS || clock.now() + wait > deadline) { stopped = true; counts.tg_deferred++; continue; }
      waited429 = true;
      await clock.sleep(wait);
      r = await attempt(it);
      if (r.status === 429) { stopped = true; counts.tg_deferred++; continue; }
    }
    if (r.status === 400 && it.fallback !== undefined && !/chat not found/i.test(r.description)) {
      counts.tg_fallback = (counts.tg_fallback ?? 0) + 1;
      r = await attempt({ ...it, text: it.fallback, markup: undefined });
      if (r.status === 429) { stopped = true; counts.tg_deferred++; continue; }
    }
    if (r.status === 401) { stopped = true; auth = true; counts.tg_auth = (counts.tg_auth ?? 0) + 1; continue; }
    if (r.ok) { counts.tg_ok++; ok.push(it.ref); }
    else if (r.status === 403 || (r.status === 400 && /chat not found/i.test(r.description))) { counts.tg_dead++; dead.push(it.ref); }
    else counts.tg_deferred++;
  }
  return { ok, dead, counts, stopped, auth };
}

/** A chart photo (Plan O spec §3.3): the PNG on first use, afterwards the file_id Telegram gave back. */
export type TgPhoto = { png: Uint8Array } | { fileId: string };
export interface TgPhotoResult extends TgSendResult { fileId: string | null }
export type TgPhotoSend = (chat: number, photo: TgPhoto, caption: string) => Promise<TgPhotoResult>;

/** sendPhoto without a notification sound; never throws; nothing is logged by this module. */
export function tgPhotoSender(token: string, fetchImpl: typeof fetch, timeoutMs = 20_000): TgPhotoSend {
  return async (chat, photo, caption) => {
    try {
      let init: RequestInit;
      if ('fileId' in photo) {
        init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, photo: photo.fileId, caption, disable_notification: true }) };
      } else {
        const form = new FormData();
        form.set('chat_id', String(chat));
        form.set('caption', caption);
        form.set('disable_notification', 'true');
        form.set('photo', new Blob([photo.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }), 'chart.png');
        init = { method: 'POST', body: form };
      }
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendPhoto`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      type TgPhotoResponse = { ok?: unknown; description?: unknown; parameters?: { retry_after?: unknown }; result?: { photo?: unknown } };
      let j: TgPhotoResponse | null = null;
      try { j = (await r.json()) as TgPhotoResponse; } catch { j = null; }
      const retry = Number(j?.parameters?.retry_after);
      const sizes: unknown = j?.result?.photo;
      const last: unknown = Array.isArray(sizes) ? (sizes.at(-1) as { file_id?: unknown } | undefined)?.file_id : undefined;
      return { ok: r.ok && j?.ok === true, status: r.status, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 0, description: typeof j?.description === 'string' ? j.description : '', fileId: typeof last === 'string' ? last : null };
    } catch {
      return { ok: false, status: 0, retryAfterS: 0, description: '', fileId: null };
    }
  };
}
