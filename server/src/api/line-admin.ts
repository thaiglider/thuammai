import { createHmac } from 'node:crypto';
import { lineApi, textMsg, uuidV5 } from '../../../src/alerts/line-api';
import { budgetVerdict, lineLimit, lineMonth, lineUsed } from '../../../src/alerts/line-budget';
import { LINE } from '../../../src/core/alert-config';
import {
  ACB, ADMIN_LINKED_TH, LINE_APPROVE_BUTTON_TH, LINE_DECIDED_ADMIN_TH, LINE_FULL_ADMIN_TH, LINE_REJECT_BUTTON_TH, lineApproveButtonText, lineApprovedAdminText, lineApprovedText,
  lineRejectButtonText, lineRejectedAdminText, lineRequestAdminText, lineRevokeButtonText, lineRevokedAdminText, lineStatusAdminText, lineUsersAdminText, type LineState,
} from '../../../src/core/line-text';
import { pausedText } from '../../../src/core/tg-text';
import { addLineSent, adminChat, lineCounts, readLineUsage } from '../line/store';
import { addCounts } from './caps';
import { publicUrl, type Deps, type Env } from './env';
import { utcDay } from './http';
import { tgApi } from './tg-api';
import type { TgCtx } from './telegram';

/* The single LINE admin, in the existing Telegram bot (phase-3C spec §4.2, R-L2). Everything here
 * checks the chat against admin.tg_chat first; another chat is treated like an unknown command. */

/** The one-time link code as stored (G-3): HMAC with RATE_HMAC_KEY, domain-separated, upper-cased. */
export const adminCodeHmac = (key: string, code: string): string => createHmac('sha256', key).update(`admin-link|${code.toUpperCase()}`).digest('hex');
const CODE_RE = /^[A-Za-z0-9]{8}$/;

/** `/admin <code>`, `/line`, `/line_users`. false → not handled (the caller answers OTHER_TH). */
export async function onAdminCommand(c: TgCtx, cmd: string, text: string): Promise<boolean> {
  const db = c.env.db;
  if (cmd === 'admin') {
    const code = text.split(/\s+/)[1] ?? '';
    if (!CODE_RE.test(code) || !c.env.RATE_HMAC_KEY) return false;
    const r = await db.query('UPDATE admin SET tg_chat = $1, link_hmac = NULL, link_expires = NULL WHERE id = 1 AND link_hmac = $2 AND link_expires > $3 RETURNING id', [c.chat, adminCodeHmac(c.env.RATE_HMAC_KEY, code), c.now]);
    if (!r.rows.length) return false;
    await c.api.send(c.chat, ADMIN_LINKED_TH);
    return true;
  }
  if (cmd !== 'line' && cmd !== 'line_users') return false;
  if ((await adminChat(db)) !== c.chat) return false;
  const month = lineMonth(c.now);
  if (cmd === 'line') {
    const u = await readLineUsage(db, month);
    const n = await lineCounts(db);
    await c.api.send(c.chat, lineStatusAdminText({ ours: u.sent, lineTotal: u.lineTotal, limit: lineLimit(u), approved: n.approved, pending: n.pending, held: u.held, exhausted: u.exhausted }));
    return true;
  }
  const rows = (await db.query<{ id: number; state: LineState; places: number; sent: number }>("SELECT u.id AS id, u.state AS state, (SELECT COUNT(*)::integer FROM follow f WHERE f.target_id = u.target_id) AS places, COALESCE((SELECT x.sent FROM line_user_usage x WHERE x.user_id = u.user_id AND x.month = $1), 0) AS sent FROM line_user u ORDER BY (u.state = 'rejected'), u.id LIMIT 50", [month])).rows;
  // Approved → [ถอนสิทธิ์]; pending → [อนุมัติ] [ปฏิเสธ], so a request whose notice was lost (no admin
  // linked yet, Telegram down) can still be decided.
  const keyboard = rows.flatMap((r) =>
    r.state === 'approved' ? [[{ text: lineRevokeButtonText(r.id), callback_data: `lv:${r.id}` }]]
      : r.state === 'pending' ? [[{ text: lineApproveButtonText(r.id), callback_data: `la:${r.id}` }, { text: lineRejectButtonText(r.id), callback_data: `lr:${r.id}` }]]
        : []);
  await c.api.send(c.chat, lineUsersAdminText(rows), keyboard.length ? { inline_keyboard: keyboard } : undefined);
  return true;
}

/** `la:<id>` / `lr:<id>` / `lv:<id>` — the callback is already answered by the caller. Buttons are
 *  cleared unless the reply is LINE_FULL_ADMIN_TH: at 20 approved nothing changed, so the buttons
 *  under the original request stay usable once someone else is revoked. */
export async function onAdminCallback(c: TgCtx, data: string, messageId: number): Promise<void> {
  if ((await adminChat(c.env.db)) !== c.chat) {
    // Not the linked admin (spec §4.2): looks exactly like any other unknown callback, paused or not
    // — the caller already answered the callback query.
    if (c.env.ALERTS_PAUSED) await c.api.send(c.chat, pausedText(publicUrl(c.env)));
    return;
  }
  const a = data.match(ACB.approve);
  const r = data.match(ACB.reject);
  const v = data.match(ACB.revoke);
  const text = a ? await approve(c, Number(a[1])) : r ? await reject(c, Number(r[1])) : v ? await revoke(c, Number(v[1])) : null;
  if (text === null) return;
  if (text !== LINE_FULL_ADMIN_TH) await c.api.clearButtons(c.chat, messageId);
  await c.api.send(c.chat, text);
}

async function approve(c: TgCtx, id: number): Promise<string> {
  const out = await c.env.db.tx(async (tx) => {
    const u = (await tx.query<{ user_id: string; state: LineState }>('SELECT user_id, state FROM line_user WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!u || u.state !== 'pending') return 'decided' as const;
    const n = (await tx.query<{ n: number }>("SELECT COUNT(*)::integer AS n FROM line_user WHERE state = 'approved'")).rows[0]?.n ?? 0;
    if (n >= LINE.maxApproved) return 'full' as const;
    const t = (await tx.query<{ id: number }>("INSERT INTO target (channel, line_user, created_at, synced_at) VALUES ('line', $1, $2, $2) ON CONFLICT (line_user) DO UPDATE SET synced_at = excluded.synced_at RETURNING id", [u.user_id, c.now])).rows[0]!;
    await tx.query("UPDATE line_user SET state = 'approved', decided_at = $1, target_id = $2 WHERE id = $3", [c.now, t.id, id]);
    await addCounts(tx, utcDay(c.now), 1, 0);
    return { user: u.user_id };
  });
  if (out === 'decided') return LINE_DECIDED_ADMIN_TH;
  if (out === 'full') return LINE_FULL_ADMIN_TH;
  return lineApprovedAdminText(id, await welcome(c.env, c.deps, out.user, c.now));
}

/** One welcome push under the budget (spec §4.2): it uses the reserve like level 4, and is counted
 *  before it is sent (G-7) — for the month only, never against the person's 10. */
async function welcome(env: Env, deps: Deps, user: string, now: Date): Promise<'sent' | 'held' | 'failed' | 'off'> {
  if (!env.LINE_CHANNEL_TOKEN || env.ALERTS_PAUSED || env.LINE_OFF) return 'off';
  const month = lineMonth(now);
  const u = await readLineUsage(env.db, month);
  if (budgetVerdict({ used: lineUsed(u), limit: lineLimit(u), exhausted: u.exhausted, level4: true, userSent: 0 }) !== 'send') return 'held';
  await addLineSent(env.db, month, null);
  const s = await lineApi(env.LINE_CHANNEL_TOKEN, deps.fetch, 5000).push(user, [textMsg(lineApprovedText())], uuidV5(`welcome|${user}|${now.getTime()}`));
  return (s >= 200 && s < 300) || s === 409 ? 'sent' : 'failed';
}

async function reject(c: TgCtx, id: number): Promise<string> {
  const r = await c.env.db.query("UPDATE line_user SET state = 'rejected', decided_at = $1 WHERE id = $2 AND state = 'pending' RETURNING id", [c.now, id]);
  return r.rows.length ? lineRejectedAdminText(id) : LINE_DECIDED_ADMIN_TH;
}

/** ถอนสิทธิ์ = the follows go (with the target) and the person is back to rejected (spec §4.2). */
async function revoke(c: TgCtx, id: number): Promise<string> {
  const done = await c.env.db.tx(async (tx) => {
    const u = (await tx.query<{ user_id: string }>("SELECT user_id FROM line_user WHERE id = $1 AND state = 'approved' FOR UPDATE", [id])).rows[0];
    if (!u) return false;
    await tx.query('DELETE FROM target WHERE line_user = $1', [u.user_id]);
    await tx.query("UPDATE line_user SET state = 'rejected', decided_at = $1, target_id = NULL, held_month = NULL, held_reason = NULL WHERE id = $2", [c.now, id]);
    return true;
  });
  return done ? lineRevokedAdminText(id) : LINE_DECIDED_ADMIN_TH;
}

/** A new request → the admin (spec §4.2). The display name is fetched now, sent once, never stored.
 *  Called from the LINE webhook, which must answer within 2 s (F4): every outbound call here — the
 *  LINE profile lookup and the Telegram send — uses LINE.replyTimeoutMs. */
export async function notifyLineRequest(env: Env, deps: Deps, id: number, user: string, now: Date): Promise<void> {
  const chat = await adminChat(env.db);
  if (chat === null || !env.TELEGRAM_BOT_TOKEN) return;
  const name = env.LINE_CHANNEL_TOKEN ? await lineApi(env.LINE_CHANNEL_TOKEN, deps.fetch, LINE.replyTimeoutMs).profileName(user) : null;
  const u = await readLineUsage(env.db, lineMonth(now));
  const n = await lineCounts(env.db);
  await tgApi(env.TELEGRAM_BOT_TOKEN, deps.fetch, LINE.replyTimeoutMs).send(chat, lineRequestAdminText({ id, name, approved: n.approved, used: lineUsed(u), limit: lineLimit(u) }), {
    inline_keyboard: [[{ text: LINE_APPROVE_BUTTON_TH, callback_data: `la:${id}` }, { text: LINE_REJECT_BUTTON_TH, callback_data: `lr:${id}` }]],
  });
}
