import type { LineUsage } from '../../../src/alerts/line-budget';
import { EMPTY_USAGE } from '../../../src/alerts/line-budget';
import { LINE } from '../../../src/core/alert-config';
import type { Db } from '../db/db';

/* SQL shared by the api (webhook, admin) and alerts (LINE sender) — phase-3C spec §6–§7. */

interface UsageRow { sent: number; held: number; line_total: number | null; line_limit: number | null; line_checked_at: Date | null; exhausted: boolean }

export async function readLineUsage(db: Db, month: string): Promise<LineUsage> {
  const r = (await db.query<UsageRow>('SELECT sent, held, line_total, line_limit, line_checked_at, exhausted FROM line_usage WHERE month = $1', [month])).rows[0];
  return r ? { sent: r.sent, held: r.held, lineTotal: r.line_total, lineLimit: r.line_limit, checkedAt: r.line_checked_at, exhausted: r.exhausted } : { ...EMPTY_USAGE };
}

/** One push counted for the month and — only while the person still exists — for them: a push in
 *  flight when they blocked the OA must not bring their user id back (Review Focus 3). `user` null:
 *  the month only (the welcome, or a level-4-only push — spec §6: the person's 10 exclude level 4). */
export async function addLineSent(db: Db, month: string, user: string | null): Promise<void> {
  await db.query('INSERT INTO line_usage (month, sent) VALUES ($1, 1) ON CONFLICT (month) DO UPDATE SET sent = line_usage.sent + 1', [month]);
  if (user !== null) {
    await db.query('INSERT INTO line_user_usage (user_id, month, sent) SELECT $1::text, $2::text, 1 WHERE EXISTS (SELECT 1 FROM line_user WHERE user_id = $1::text) ON CONFLICT (user_id, month) DO UPDATE SET sent = line_user_usage.sent + 1', [user, month]);
  }
}

export async function addLineHeld(db: Db, month: string, n: number): Promise<void> {
  if (n <= 0) return;
  await db.query('INSERT INTO line_usage (month, held) VALUES ($1, $2) ON CONFLICT (month) DO UPDATE SET held = line_usage.held + excluded.held', [month, n]);
}

/** LINE's own numbers (F8); a null (LINE did not answer) keeps the last known value. A fresh total
 *  below the limit (min(300, quota)) clears `exhausted`: a 429 is not a month-long verdict when LINE
 *  itself later reports room (e.g. a quota raised mid-month). */
export async function saveLineCheck(db: Db, month: string, total: number | null, limit: number | null, at: Date): Promise<void> {
  await db.query('INSERT INTO line_usage (month, line_total, line_limit, line_checked_at) VALUES ($1, $2, $3, $4) ON CONFLICT (month) DO UPDATE SET line_total = COALESCE(excluded.line_total, line_usage.line_total), line_limit = COALESCE(excluded.line_limit, line_usage.line_limit), line_checked_at = excluded.line_checked_at, exhausted = CASE WHEN excluded.line_total IS NOT NULL AND excluded.line_total < LEAST($5::integer, COALESCE(excluded.line_limit, line_usage.line_limit, $5::integer)) THEN false ELSE line_usage.exhausted END', [month, total, limit, at, LINE.monthlyLimit]);
}

/** A 429 from LINE (F3): nothing more is pushed this month. Returns true only the first time this
 *  month flips to exhausted — the caller sends the admin notice once from that. */
export async function markLineExhausted(db: Db, month: string): Promise<boolean> {
  return (await db.query('INSERT INTO line_usage (month, exhausted) VALUES ($1, true) ON CONFLICT (month) DO UPDATE SET exhausted = true WHERE NOT line_usage.exhausted RETURNING month', [month])).rows.length > 0;
}

export type NoticeKind = 'held' | 'low' | 'auth';
/** true the first time per kind and Bangkok day (the admin hears once a day, spec §4.2). */
export async function noticeOnce(db: Db, month: string, kind: NoticeKind, day: string): Promise<boolean> {
  if (kind === 'held') return (await db.query('INSERT INTO line_usage (month, held_notice_day) VALUES ($1, $2) ON CONFLICT (month) DO UPDATE SET held_notice_day = excluded.held_notice_day WHERE line_usage.held_notice_day IS DISTINCT FROM excluded.held_notice_day RETURNING month', [month, day])).rows.length > 0;
  if (kind === 'low') return (await db.query('INSERT INTO line_usage (month, low_notice_day) VALUES ($1, $2) ON CONFLICT (month) DO UPDATE SET low_notice_day = excluded.low_notice_day WHERE line_usage.low_notice_day IS DISTINCT FROM excluded.low_notice_day RETURNING month', [month, day])).rows.length > 0;
  return (await db.query('INSERT INTO line_usage (month, auth_notice_day) VALUES ($1, $2) ON CONFLICT (month) DO UPDATE SET auth_notice_day = excluded.auth_notice_day WHERE line_usage.auth_notice_day IS DISTINCT FROM excluded.auth_notice_day RETURNING month', [month, day])).rows.length > 0;
}

/** unfollow, "เลิก", or LINE answering 400 for this person: everything that holds the user id, in
 *  one transaction (spec §4.1 step 7, §12.5). The month total in line_usage stays (quota spent). */
export async function deleteLineUser(db: Db, user: string): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query('DELETE FROM target WHERE line_user = $1', [user]);
    await tx.query('DELETE FROM line_user WHERE user_id = $1', [user]);
    await tx.query('DELETE FROM line_pending WHERE user_id = $1', [user]);
    await tx.query('DELETE FROM line_user_usage WHERE user_id = $1', [user]);
  });
}

export async function adminChat(db: Db): Promise<number | null> {
  return (await db.query<{ tg_chat: number | null }>('SELECT tg_chat FROM admin WHERE id = 1')).rows[0]?.tg_chat ?? null;
}

export async function lineCounts(db: Db): Promise<{ approved: number; pending: number }> {
  const r = (await db.query<{ approved: number; pending: number }>("SELECT COUNT(*) FILTER (WHERE state = 'approved')::integer AS approved, COUNT(*) FILTER (WHERE state = 'pending')::integer AS pending FROM line_user")).rows[0];
  return r ?? { approved: 0, pending: 0 };
}
