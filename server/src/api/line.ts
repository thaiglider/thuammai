import { lineApi, lineSignatureOk, LOCATION_ACTION, textMsg, USER_ID_RE, type LineAction, type LineApi } from '../../../src/alerts/line-api';
import { lineMonth } from '../../../src/alerts/line-budget';
import { BODY_MAX, LINE, RATE } from '../../../src/core/alert-config';
import { alertKey, parseAlertKey } from '../../../src/core/alert-key';
import { parseCoords } from '../../../src/core/coords';
import { inThailand } from '../../../src/core/geo';
import {
  LINE_ALIAS, LINE_ALREADY_APPROVED_TH, LINE_CANCEL_BUTTON_TH, LINE_CMD, LINE_MAX_FOLLOWS_TH, LINE_NO_FOLLOWS_TH, LINE_NOT_APPROVED_FOLLOW_TH, LINE_OTHER_TH,
  LINE_RENAME_HOWTO_TH, LINE_RENAME_RE, LINE_REQUEST_LIMIT_TH, LINE_REQUEST_PENDING_TH, LINE_REQUESTED_TH, LINE_REQUESTS_CLOSED_TH, LINE_STOP_ALL_BUTTON_TH,
  LINE_STOP_CONFIRM_TH, LINE_STOPPED_TH, lineFollowedText, lineHelpText, lineListText, lineOffText, lineRejectedText, lineRenamedText, lineUnfollowButtonText,
  lineWelcomeText, LPB, type HeldReason, type LineState,
} from '../../../src/core/line-text';
import { ALREADY_TH, coordsReadText, dbDownText, defaultLabel, fullSystemText, NOT_A_REPORT_TH, NOT_FOUND_TH, OUTSIDE_TH, pausedText, tgName, unfollowedText } from '../../../src/core/tg-text';
import { deleteLineUser } from '../line/store';
import { addCounts, capsAllow } from './caps';
import type { Deps, Env } from './env';
import { err, HttpError, json, readBody, utcDay } from './http';
import { notifyLineRequest } from './line-admin';
import { counterRate, counterRateDaily } from './ratelimit';
import { alertsStatus } from './status';
import { stage1For } from './telegram';
import { isObj } from './validate';

/* POST /v1/line (phase-3C spec §5.1). The signature is checked on the raw bytes before anything
 * else; once it is right the answer is always 200. Replies are free (F2) and each reply token is
 * used at most once (F4). */

export interface LineCtx { env: Env; deps: Deps; api: LineApi; user: string; token: string | null; now: Date; used: boolean }

export const pbAction = (label: string, data: string): LineAction => ({ type: 'postback', label, data, displayText: label });

export async function lineRoute(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_TOKEN || !env.RATE_HMAC_KEY) return err(503, 'unavailable');
  let raw: Uint8Array;
  try {
    raw = await readBody(req, BODY_MAX.telegram);
  } catch (e) {
    return e instanceof HttpError && e.status === 413 ? err(413, 'too_large') : err(400, 'bad_request');
  }
  if (!lineSignatureOk(env.LINE_CHANNEL_SECRET, raw, req.headers.get('x-line-signature'))) return err(401, 'unauthorized');
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { body = null; }
  const events = isObj(body) && Array.isArray(body.events) ? body.events.slice(0, LINE.eventsPerRequest) : [];
  for (const e of events) {
    try { await handleEvent(e, env, deps); } catch { /* 200 whenever signed */ }
  }
  return json(200, { ok: true });
}

/** Answer once; a context whose token went to line_pending (Task 6) never replies here. */
export async function lineReply(c: LineCtx, text: string, actions?: LineAction[]): Promise<void> {
  if (!c.token || c.used) return;
  c.used = true;
  await c.api.reply(c.token, [textMsg(text, actions)]);
}

/** While paused or LINE_OFF (G-5, G-6): listing, deleting, the how-to, their aliases and renaming
 *  (it only changes the person's own label) still work. */
const allowedWhileOff = (text: string | null, pb: string | null): boolean =>
  (text !== null && (
    text === LINE_CMD.list || text === LINE_CMD.stop || text === LINE_CMD.help ||
    LINE_ALIAS.list.test(text) || LINE_ALIAS.stop.test(text) || LINE_ALIAS.help.test(text) ||
    LINE_RENAME_RE.test(text)
  )) ||
  (pb !== null && (LPB.unfollow.test(pb) || LPB.stopAll.test(pb) || LPB.dismiss.test(pb)));

async function handleEvent(e: unknown, env: Env, deps: Deps): Promise<void> {
  if (!isObj(e) || !isObj(e.source) || e.source.type !== 'user' || typeof e.source.userId !== 'string' || !USER_ID_RE.test(e.source.userId)) return;
  const user = e.source.userId;
  // Blocking the OA deletes everything at once — no rate limit may stop a deletion (R-L9, G-10).
  if (e.type === 'unfollow') { await deleteLineUser(env.db, user); return; }
  const token = typeof e.replyToken === 'string' && e.replyToken.length > 0 && e.replyToken.length <= 256 ? e.replyToken : null;
  if (!token) return;
  const message = e.type === 'message' && isObj(e.message) ? e.message : null;
  const pb = e.type === 'postback' && isObj(e.postback) && typeof e.postback.data === 'string' ? e.postback.data : null;
  if (e.type !== 'follow' && message === null && pb === null) return;
  const text = message !== null && message.type === 'text' && typeof message.text === 'string' ? message.text.trim() : null;
  const now = deps.now();
  const c: LineCtx = { env, deps, api: lineApi(env.LINE_CHANNEL_TOKEN!, deps.fetch, LINE.replyTimeoutMs), user, token, now, used: false };
  try {
    const deletion = pb !== null && LPB.stopAll.test(pb);
    const allowed = deletion
      ? await counterRate(env, 'line', user, RATE.tgUpdatesPerChatPerMin, now, 'minute')
      : await counterRateDaily(env, 'line', user, RATE.tgUpdatesPerChatPerMin, RATE.tgUpdatesPerChatPerDay, now);
    if (!allowed) return;
    if ((env.ALERTS_PAUSED || env.LINE_OFF) && !allowedWhileOff(text, pb)) {
      await lineReply(c, env.LINE_OFF ? lineOffText(env.SITE_URL) : pausedText(env.SITE_URL));
      return;
    }
    if (e.type === 'follow') { await lineReply(c, lineWelcomeText(env.SITE_URL), [LOCATION_ACTION]); return; }
    if (pb !== null) { await onPostback(c, pb); return; }
    if (message !== null && message.type === 'location') {
      if (num(message.latitude) && num(message.longitude)) { await onLocation(c, message.latitude, message.longitude, false); return; }
      await lineReply(c, LINE_OTHER_TH, [LOCATION_ACTION]);
      return;
    }
    if (text !== null) { await onText(c, text); return; }
    await lineReply(c, LINE_OTHER_TH, [LOCATION_ACTION]);
  } catch {
    await lineReply(c, dbDownText(env.SITE_URL));
  }
}

async function onText(c: LineCtx, text: string): Promise<void> {
  if (text === LINE_CMD.request) return onRequest(c);
  if (text === LINE_CMD.list || LINE_ALIAS.list.test(text)) return onList(c);
  if (text === LINE_CMD.stop || LINE_ALIAS.stop.test(text)) return lineReply(c, LINE_STOP_CONFIRM_TH, [pbAction(LINE_STOP_ALL_BUTTON_TH, 'ld:all'), pbAction(LINE_CANCEL_BUTTON_TH, 'no')]);
  if (text === LINE_CMD.help || LINE_ALIAS.help.test(text)) return lineReply(c, lineHelpText(c.env.SITE_URL), [LOCATION_ACTION]);
  const rename = text.match(LINE_RENAME_RE);
  if (rename) return onRename(c, Number(rename[1]), rename[2]!);
  // Typed coordinates or a full map link (LINE on a computer may not send a location, F10).
  const typed = parseCoords(text);
  if (typed) return onLocation(c, typed.lat, typed.lon, true);
  return lineReply(c, LINE_OTHER_TH, [LOCATION_ACTION]);
}

/** ขอรับแจ้งเตือน (spec §4.1 step 2, §5.1): once a day per person, ≤50 pending in all, 30 days after a
 *  rejection. Controller ruling: the once-a-day check runs AFTER the system-wide pending-count check
 *  and right before the INSERT — a request refused for "ปิดรับคำขอชั่วคราว" (requests closed) must not
 *  spend the person's one request for the day. */
async function onRequest(c: LineCtx): Promise<void> {
  const db = c.env.db;
  const u = (await db.query<{ state: LineState; decided_at: Date | null }>('SELECT state, decided_at FROM line_user WHERE user_id = $1', [c.user])).rows[0];
  if (u?.state === 'approved') return lineReply(c, LINE_ALREADY_APPROVED_TH, [LOCATION_ACTION]);
  if (u?.state === 'pending') return lineReply(c, LINE_REQUEST_PENDING_TH, [LOCATION_ACTION]);
  if (u?.state === 'rejected' && u.decided_at && c.now.getTime() - u.decided_at.getTime() < LINE.rejectCooldownDays * 86400e3) return lineReply(c, lineRejectedText(c.env.SITE_URL));
  const pending = (await db.query<{ n: number }>("SELECT COUNT(*)::integer AS n FROM line_user WHERE state = 'pending'")).rows[0]?.n ?? 0;
  if (pending >= LINE.requestsPending) return lineReply(c, LINE_REQUESTS_CLOSED_TH);
  if (!(await counterRate(c.env, 'lreq', c.user, 1, c.now, 'day'))) return lineReply(c, LINE_REQUEST_LIMIT_TH);
  const row = (await db.query<{ id: number }>("INSERT INTO line_user (user_id, state, requested_at) VALUES ($1, 'pending', $2) ON CONFLICT (user_id) DO UPDATE SET state = 'pending', requested_at = excluded.requested_at, decided_at = NULL WHERE line_user.state = 'rejected' RETURNING id", [c.user, c.now])).rows[0];
  if (!row) return lineReply(c, LINE_REQUEST_PENDING_TH, [LOCATION_ACTION]);
  await lineReply(c, LINE_REQUESTED_TH, [LOCATION_ACTION]);
  await notifyLineRequest(c.env, c.deps, row.id, c.user, c.now);
}

async function onList(c: LineCtx): Promise<void> {
  const db = c.env.db;
  const rows = (await db.query<{ id: number; label: string | null; key: string }>('SELECT f.id AS id, f.label AS label, f.key AS key FROM follow f JOIN target t ON t.id = f.target_id WHERE t.line_user = $1 ORDER BY f.id', [c.user])).rows;
  if (!rows.length) return lineReply(c, LINE_NO_FOLLOWS_TH, [LOCATION_ACTION]);
  const month = lineMonth(c.now);
  const u = (await db.query<{ held_month: string | null; held_reason: HeldReason | null; sent: number }>('SELECT u.held_month AS held_month, u.held_reason AS held_reason, COALESCE((SELECT x.sent FROM line_user_usage x WHERE x.user_id = u.user_id AND x.month = $2), 0) AS sent FROM line_user u WHERE u.user_id = $1', [c.user, month])).rows[0];
  const list = rows.map((r) => ({ id: r.id, key: r.key, label: r.label ?? 'จุดที่ติดตาม' }));
  await lineReply(c, lineListText(list, u?.sent ?? 0, u?.held_month === month ? u.held_reason : null), list.map((r) => pbAction(lineUnfollowButtonText(r.label), `lu:${r.id}`)));
}

/** ชื่อ/ตั้งชื่อ <n> <name> (owner-approved follow-up): `<n>` is 1-based, in the same order รายการ
 *  shows (follow id order) — approved people with follows only, allowed while paused/LINE_OFF. */
async function onRename(c: LineCtx, n: number, raw: string): Promise<void> {
  const db = c.env.db;
  const u = (await db.query<{ state: LineState; target_id: number | null }>('SELECT state, target_id FROM line_user WHERE user_id = $1', [c.user])).rows[0];
  if (!u || u.state !== 'approved' || u.target_id === null) return lineReply(c, LINE_NOT_APPROVED_FOLLOW_TH);
  const rows = (await db.query<{ id: number }>('SELECT f.id AS id FROM follow f JOIN target t ON t.id = f.target_id WHERE t.line_user = $1 ORDER BY f.id', [c.user])).rows;
  if (!rows.length) return lineReply(c, LINE_NO_FOLLOWS_TH, [LOCATION_ACTION]);
  const target = n >= 1 ? rows[n - 1] : undefined;
  if (!target) return lineReply(c, NOT_FOUND_TH);
  const label = tgName(raw);
  if (!label) return lineReply(c, LINE_RENAME_HOWTO_TH);
  await db.query('UPDATE follow SET label = $1 WHERE id = $2', [label, target.id]);
  await lineReply(c, lineRenamedText(n, label));
}

async function onPostback(c: LineCtx, data: string): Promise<void> {
  const f = data.match(LPB.follow);
  if (f) return onFollow(c, f[1]!);
  const u = data.match(LPB.unfollow);
  if (u) return onUnfollow(c, Number(u[1]));
  if (LPB.stopAll.test(data)) {
    await deleteLineUser(c.env.db, c.user);
    return lineReply(c, LINE_STOPPED_TH);
  }
  // `no` and anything else: nothing to say.
}

/** ติดตามจุดนี้ — approved people only, ≤2 places (R-L3). */
async function onFollow(c: LineCtx, key: string): Promise<void> {
  const p = parseAlertKey(key);
  if (!p || !inThailand(p.lat, p.lon)) return;
  const db = c.env.db;
  const u = (await db.query<{ state: LineState; target_id: number | null }>('SELECT state, target_id FROM line_user WHERE user_id = $1', [c.user])).rows[0];
  if (u?.state === 'rejected') return lineReply(c, lineRejectedText(c.env.SITE_URL));
  if (!u || u.state !== 'approved' || u.target_id === null) return lineReply(c, LINE_NOT_APPROVED_FOLLOW_TH);
  const target = u.target_id;
  const mine = (await db.query<{ key: string; label: string | null }>('SELECT key, label FROM follow WHERE target_id = $1', [target])).rows;
  if (mine.some((r) => r.key === key)) return lineReply(c, ALREADY_TH);
  if (mine.length >= LINE.placesPerUser) return lineReply(c, LINE_MAX_FOLLOWS_TH);
  const day = utcDay(c.now);
  const known = (await db.query('SELECT key FROM place WHERE key = $1', [key])).rows.length > 0;
  if (!(await capsAllow(db, day, 0, known ? 0 : 1))) return lineReply(c, fullSystemText(c.env.SITE_URL));
  const label = defaultLabel(mine.map((r) => r.label ?? ''));
  const created = await db.tx(async (tx) => {
    await tx.query('INSERT INTO place (key, lat, lon, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING', [key, p.lat, p.lon, c.now]);
    const ins = (await tx.query('INSERT INTO follow (target_id, key, label, created_at) SELECT $1::bigint, $2::text, $3::text, $4::timestamptz WHERE (SELECT COUNT(*) FROM follow WHERE target_id = $1::bigint) < $5::integer ON CONFLICT (target_id, key) DO NOTHING RETURNING id', [target, key, label, c.now, LINE.placesPerUser])).rows.length > 0;
    if (!ins) return false;
    await addCounts(tx, day, 0, known ? 0 : 1);
    return true;
  });
  await lineReply(c, created ? lineFollowedText(label) : ALREADY_TH);
}

async function onUnfollow(c: LineCtx, fid: number): Promise<void> {
  const r = (await c.env.db.query<{ label: string | null }>('DELETE FROM follow WHERE id = $1 AND target_id = (SELECT id FROM target WHERE line_user = $2) RETURNING label', [fid, c.user])).rows[0];
  await lineReply(c, r ? unfollowedText(r.label ?? 'จุดที่ติดตาม') : NOT_FOUND_TH);
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** A place (spec §5.1): outside Thailand → answered now; alerts stalled → stage 1 now; otherwise a
 *  question for alerts (NOTIFY wakes it, R-L8) — or stage 1 now when this person already has
 *  LINE.pendingPerUser questions waiting (G-10). */
async function onLocation(c: LineCtx, lat: number, lon: number, typed: boolean): Promise<void> {
  if (!inThailand(lat, lon)) return lineReply(c, typed ? `${OUTSIDE_TH}\n${NOT_A_REPORT_TH}` : OUTSIDE_TH, [LOCATION_ACTION]);
  const key = alertKey(lat, lon);
  const stalled = (await alertsStatus(c.env, c.now)) === 'stalled';
  if (!stalled && c.token && !c.used) {
    const id = await addPending(c, key, typed);
    if (id !== null) {
      // The token now belongs to the line_pending row: only a successful claim may use it.
      c.used = true;
      scheduleFallback(c.env, c.deps, c.api, id, key, typed);
      return;
    }
  }
  await lineReply(c, await lineStage1(c.env, c.deps, c.now, key, typed, stalled ? 'stalled' : 'full'), [LOCATION_ACTION]);
}

/** At most LINE.pendingPerUser fresh (≤LINE.pendingMaxAgeS old, unclaimed) rows per person. */
async function addPending(c: LineCtx, key: string, typed: boolean): Promise<number | null> {
  const fresh = new Date(c.now.getTime() - LINE.pendingMaxAgeS * 1000);
  const n = (await c.env.db.query<{ n: number }>('SELECT COUNT(*)::integer AS n FROM line_pending WHERE user_id = $1 AND claimed_at IS NULL AND created_at >= $2', [c.user, fresh])).rows[0]?.n ?? 0;
  if (n >= LINE.pendingPerUser) return null;
  return c.env.db.tx(async (tx) => {
    const id = (await tx.query<{ id: number }>('INSERT INTO line_pending (user_id, key, typed, reply_token, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id', [c.user, key, typed, c.token, c.now])).rows[0]!.id;
    // Delivered on commit: alerts' LISTEN connection moves its next tick forward (spec §5.2).
    await tx.query("SELECT pg_notify('thuammai_wake', '')");
    return id;
  });
}

/** Stage 1: the province overview and a line that promises nothing ('stalled' or 'full') — LINE's own
 *  reply budget (spec §5.1), never Telegram's default. A typed place echoes the (rounded, G-12)
 *  point and keeps the emergency numbers. */
export async function lineStage1(env: Env, deps: Deps, now: Date, key: string, typed: boolean, pending: 'full' | 'stalled'): Promise<string> {
  const text = await stage1For(env, deps, now, key, pending, LINE.replyTimeoutMs);
  if (!typed) return text;
  const [klat, klon] = key.split(',').map(Number) as [number, number];
  return `${coordsReadText(klat, klon)}\n${text}\n${NOT_A_REPORT_TH}`;
}

/** Production default for `deps.later` (Task 6 ruling 4): a fallback whose `fn` throws or rejects
 *  must never become an unhandled rejection — Node 24 exits on those. Exported so it can be tested
 *  directly, without a real 40-second timer. */
export function defaultLater(ms: number, fn: () => Promise<void>): void {
  setTimeout(() => {
    void (async () => {
      try { await fn(); } catch { /* nothing to log per spec §7.4; the person can send the place again */ }
    })();
  }, ms).unref();
}

/** กันหาย (spec §5.1, R-L8): still unclaimed after LINE.apiFallbackS → claim it here (atomic — the
 *  loser of a race with alerts gets no row) and answer with stage 1. The timer lives in this process:
 *  a restart in between loses the answer (accepted — the person can send the place again). */
function scheduleFallback(env: Env, deps: Deps, api: LineApi, id: number, key: string, typed: boolean): void {
  const later = deps.later ?? defaultLater;
  later(LINE.apiFallbackS * 1000, async () => {
    try {
      const at = deps.now();
      const r = (await env.db.query<{ reply_token: string }>('UPDATE line_pending SET claimed_at = $1 WHERE id = $2 AND claimed_at IS NULL RETURNING reply_token', [at, id])).rows[0];
      if (!r) return;
      await env.db.query('DELETE FROM line_pending WHERE id = $1', [id]);
      await api.reply(r.reply_token, [textMsg(await lineStage1(env, deps, at, key, typed, 'stalled'), [LOCATION_ACTION])]);
    } catch {
      // Nothing to log per spec §7.4; the person can send the place again.
    }
  });
}
