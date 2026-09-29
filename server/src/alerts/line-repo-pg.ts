import type { LinePendingRow, LineRepo } from '../../../src/alerts/line-repo';
import { RepoError } from '../../../src/alerts/repo';
import { LINE } from '../../../src/core/alert-config';
import { parseAlertKey } from '../../../src/core/alert-key';
import type { HeldReason, LineState } from '../../../src/core/line-text';
import type { Db } from '../db/db';
import { addLineHeld, addLineSent, adminChat as readAdminChat, deleteLineUser, markLineExhausted, noticeOnce as markNotice, readLineUsage, saveLineCheck } from '../line/store';
import { writeFollows } from './repo-pg';

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new RepoError();
  }
}

export function pgLineRepo(db: Db): LineRepo {
  return {
    // Controller ruling: the api's 40 s fallback may claim a row up to LINE.pendingDropS old, so
    // alerts must not delete what it could still claim — only rows past pendingDropS are dropped
    // here, and the claim below never reaches past pendingMaxAgeS (rows 45–60 s old are the
    // fallback's alone).
    claimPending: (now) => guard(async () => {
      await db.query('DELETE FROM line_pending WHERE created_at < $1', [new Date(now.getTime() - LINE.pendingDropS * 1000)]);
      const qs = (await db.query<{ id: number; user_id: string; key: string; typed: boolean; reply_token: string }>('UPDATE line_pending SET claimed_at = $1 WHERE id IN (SELECT id FROM line_pending WHERE claimed_at IS NULL AND created_at >= $2 ORDER BY id LIMIT $3) AND claimed_at IS NULL RETURNING id, user_id, key, typed, reply_token', [now, new Date(now.getTime() - LINE.pendingMaxAgeS * 1000), LINE.answersPerTick])).rows;
      if (!qs.length) return [];
      const users = [...new Set(qs.map((q) => q.user_id))];
      const us = (await db.query<{ user_id: string; state: LineState; held_month: string | null; held_reason: HeldReason | null }>('SELECT user_id, state, held_month, held_reason FROM line_user WHERE user_id = ANY($1::text[])', [users])).rows;
      const fs = (await db.query<{ user: string; key: string }>('SELECT t.line_user AS "user", f.key AS key FROM follow f JOIN target t ON t.id = f.target_id WHERE t.line_user = ANY($1::text[])', [users])).rows;
      return qs.sort((a, b) => a.id - b.id).flatMap((q): LinePendingRow[] => {
        const p = parseAlertKey(q.key);
        if (!p) return [];
        const u = us.find((x) => x.user_id === q.user_id);
        return [{ id: q.id, user: q.user_id, k: q.key, lat: p.lat, lon: p.lon, typed: q.typed, token: q.reply_token, state: u?.state ?? null, follows: fs.filter((f) => f.user === q.user_id).map((f) => f.key), heldMonth: u?.held_month ?? null, heldReason: u?.held_reason ?? null }];
      });
    }),
    done: (ids) => guard(async () => {
      if (ids.length) await db.query('DELETE FROM line_pending WHERE id = ANY($1::bigint[])', [ids]);
    }),
    usage: (month) => guard(() => readLineUsage(db, month)),
    saveCheck: (month, total, limit, at) => guard(() => saveLineCheck(db, month, total, limit, at)),
    userSent: (month, users) => guard(async () => {
      if (!users.length) return {};
      const rs = (await db.query<{ user_id: string; sent: number }>('SELECT user_id, sent FROM line_user_usage WHERE month = $1 AND user_id = ANY($2::text[])', [month, users])).rows;
      return Object.fromEntries(rs.map((r) => [r.user_id, r.sent]));
    }),
    report: (r) => guard(() => db.tx(async (t) => {
      await writeFollows(t, r.follows);
      await addLineSent(t, r.month, r.counted ? r.user : null);
      await t.query('UPDATE line_user SET held_month = NULL, held_reason = NULL WHERE user_id = $1', [r.user]);
    })),
    held: (month, people, events) => guard(() => db.tx(async (t) => {
      for (const p of people) await t.query('UPDATE line_user SET held_month = $1, held_reason = $2 WHERE user_id = $3', [month, p.reason, p.user]);
      await addLineHeld(t, month, events);
    })),
    exhausted: (month) => guard(() => markLineExhausted(db, month)),
    deleteUser: (user) => guard(() => deleteLineUser(db, user)),
    noticeOnce: (month, kind, day) => guard(() => markNotice(db, month, kind, day)),
    adminChat: () => guard(() => readAdminChat(db)),
  };
}
