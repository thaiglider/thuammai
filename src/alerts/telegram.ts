import type { Counts } from './log';

export interface TgSendResult { ok: boolean; status: number; retryAfterS: number; description: string }
export type TgSend = (chat: number, text: string) => Promise<TgSendResult>;
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export interface TgItem<T> { chat: number; text: string; ref: T }

/** research §4: ~30/s overall and ~1/s per chat are community numbers, so we stay below them. */
export const TG_PACE = { perSecond: 25, perChatMs: 1000, maxRetryAfterS: 30 } as const;

/** sendMessage from the alerts job: plain text, no link preview; never throws; only the status,
 *  retry_after and description come back (nothing is logged by this module). */
export function tgSender(token: string, fetchImpl: typeof fetch, timeoutMs = 10_000): TgSend {
  return async (chat, text) => {
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, link_preview_options: { is_disabled: true } }),
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
 *  (`stopped` and `auth`), like push's VAPID stop — no chat is ever treated as dead for it. */
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
    const r = await send(it.chat, it.text);
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
    if (r.status === 401) { stopped = true; auth = true; counts.tg_auth = (counts.tg_auth ?? 0) + 1; continue; }
    if (r.ok) { counts.tg_ok++; ok.push(it.ref); }
    else if (r.status === 403 || (r.status === 400 && /chat not found/i.test(r.description))) { counts.tg_dead++; dead.push(it.ref); }
    else counts.tg_deferred++;
  }
  return { ok, dead, counts, stopped, auth };
}
