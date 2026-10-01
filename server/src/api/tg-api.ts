import type { TgInlineButton } from '../../../src/core/tg-text';

export interface TgResult { ok: boolean; status: number }
/** A callback button or a link button (Plan O spec §2.4). */
export type InlineButton = TgInlineButton;
export type ReplyMarkup =
  | { inline_keyboard: InlineButton[][] }
  | { keyboard: { text: string; request_location?: boolean }[][]; resize_keyboard?: boolean };

export interface TgApi {
  send(chat: number, text: string, markup?: ReplyMarkup): Promise<TgResult>;
  answer(callbackId: string): Promise<TgResult>;
  clearButtons(chat: number, messageId: number): Promise<TgResult>;
}

/** Bot API calls from the webhook (spec §7.1): plain text, no link previews (ruling 1), 5 s
 *  timeout, never throws — a failed reply must not make Telegram resend the update. */
export function tgApi(token: string, fetchImpl: typeof fetch, timeoutMs = 5000): TgApi {
  const call = async (method: string, body: Record<string, unknown>): Promise<TgResult> => {
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: r.ok, status: r.status };
    } catch {
      return { ok: false, status: 0 };
    }
  };
  return {
    send: (chat, text, markup) => call('sendMessage', { chat_id: chat, text, link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) }),
    answer: (callbackId) => call('answerCallbackQuery', { callback_query_id: callbackId }),
    clearButtons: (chat, messageId) => call('editMessageReplyMarkup', { chat_id: chat, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  };
}
