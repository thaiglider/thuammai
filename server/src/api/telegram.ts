import { BODY_MAX, CAPS, RATE } from '../../../src/core/alert-config';
import { alertKey, parseAlertKey } from '../../../src/core/alert-key';
import { parseCoords } from '../../../src/core/coords';
import { inThailand } from '../../../src/core/geo';
import { ACB } from '../../../src/core/line-text';
import {
  ALREADY_TH, CANCEL_BUTTON_TH, CB, coordsReadText, dbDownText, defaultLabel, DISMISS_BUTTON_TH, FOLLOW_BUTTON_TH, followedText, fullSystemText,
  FOLLOW_FALLBACK_LABEL_TH, FOLLOWED_BUTTON_TH, helpText, labelSetText, listText, MAX_FOLLOWS_TH, NEW_FOLLOWS_CAP_TH, NO_FOLLOWS_TH, NOT_A_REPORT_TH, NOT_FOUND_TH,
  OTHER_TH, OUTSIDE_TH, pausedText, provinceTitle, SEND_LOCATION_TH, siteLink, skipText, stage1Text, START_TH, STOP_ALL_BUTTON_TH, STOP_CONFIRM_TH,
  STALLED_LINE_TH, STOPPED_TH, tgName, UNFOLLOW_BUTTON_TH, unfollowedText, VIEW_FULL_TH, viewButtonText, type Stage1,
} from '../../../src/core/tg-text';
import { provinceArea, provinceFor } from './areas';
import { addCounts, boundedCount, capsAllow } from './caps';
import { publicUrl, type Deps, type Env } from './env';
import { err, json, readJson, safeEqual, utcDay } from './http';
import { onAdminCallback, onAdminCommand } from './line-admin';
import { counterRate, counterRateDaily, rateName } from './ratelimit';
import { alertsStatus } from './status';
import { tgApi, type ReplyMarkup, type TgApi } from './tg-api';
import { isObj } from './validate';

export interface TgMsg {
  message_id: number;
  chat: { id: number; type: string };
  text?: unknown;
  location?: { latitude?: unknown; longitude?: unknown };
  venue?: { location?: { latitude?: unknown; longitude?: unknown } };
}
export interface TgCallback { id: string; data?: unknown; message: TgMsg }
export interface TgCtx { env: Env; deps: Deps; api: TgApi; chat: number; now: Date; answered: boolean }

export const LOCATION_KEYBOARD: ReplyMarkup = { keyboard: [[{ text: SEND_LOCATION_TH, request_location: true }, { text: FOLLOWED_BUTTON_TH }]], resize_keyboard: true };
const AREA_STALE_MIN = 180;

/** POST /v1/telegram (phase-2 spec §4, §7). 200 whenever the secret is right, so Telegram never resends. */
export async function telegramRoute(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  // RATE_HMAC_KEY hashes the per-chat counters (chat ids are never stored raw in `counter`).
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.RATE_HMAC_KEY) return err(503, 'unavailable');
  if (!(await safeEqual(req.headers.get('x-telegram-bot-api-secret-token') ?? '', env.TELEGRAM_WEBHOOK_SECRET))) return err(401, 'unauthorized');
  let update: unknown;
  try { update = await readJson(req, BODY_MAX.telegram); } catch { return json(200, { ok: true }); }
  try { await handleUpdate(update, env, deps); } catch { /* a reply failed: never make Telegram retry */ }
  return json(200, { ok: true });
}

function asMsg(x: unknown): TgMsg | null {
  if (!isObj(x) || !isObj(x.chat) || !Number.isSafeInteger(x.chat.id) || typeof x.chat.type !== 'string' || !Number.isSafeInteger(x.message_id)) return null;
  return x as unknown as TgMsg;
}
function asCallback(x: unknown): TgCallback | null {
  if (!isObj(x) || typeof x.id !== 'string') return null;
  const message = asMsg(x.message);
  return message ? { id: x.id, data: x.data, message } : null;
}
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const STOP_CMD_RE = /^\/stop(?:@\w+)?(?:\s|$)/i;
const PAUSE_OK_CMD_RE = /^\/(?:stop|list|help|admin|line|line_users)(?:@\w+)?(?:\s|$)/i;
/** `/stop` and its "ลบทั้งหมด" button skip the per-chat DAY cap (final review M4). */
const isDeletion = (msg: TgMsg | null, cb: TgCallback | null): boolean =>
  (msg !== null && typeof msg.text === 'string' && STOP_CMD_RE.test(msg.text.trim())) ||
  (cb !== null && typeof cb.data === 'string' && CB.stopAll.test(cb.data));
const isAdminCallback = (data: string): boolean => ACB.approve.test(data) || ACB.reject.test(data) || ACB.revoke.test(data);
/** While paused (F1-8, G-6): deleting, listing, help, unfollow, cancel and the admin still work. */
const allowedWhilePaused = (msg: TgMsg | null, cb: TgCallback | null): boolean =>
  (msg !== null && typeof msg.text === 'string' && (PAUSE_OK_CMD_RE.test(msg.text.trim()) || msg.text.trim() === FOLLOWED_BUTTON_TH)) ||
  (cb !== null && typeof cb.data === 'string' && (CB.stopAll.test(cb.data) || CB.unfollow.test(cb.data) || CB.dismiss.test(cb.data) || isAdminCallback(cb.data)));

export async function handleUpdate(update: unknown, env: Env, deps: Deps): Promise<void> {
  if (!isObj(update)) return;
  const msg = asMsg(update.message);
  const cb = asCallback(update.callback_query);
  const chat = msg?.chat ?? cb?.message.chat;
  if (!chat || chat.type !== 'private') return; // groups and channels: ignored
  const now = deps.now();
  const c: TgCtx = { env, deps, api: tgApi(env.TELEGRAM_BOT_TOKEN!, deps.fetch), chat: chat.id, now, answered: false };
  try {
    const allowed = isDeletion(msg, cb)
      ? await counterRate(env, 'tg', String(chat.id), RATE.tgUpdatesPerChatPerMin, now, 'minute')
      : await counterRateDaily(env, 'tg', String(chat.id), RATE.tgUpdatesPerChatPerMin, RATE.tgUpdatesPerChatPerDay, now);
    if (!allowed) {
      if (cb) { await c.api.answer(cb.id); c.answered = true; }
      return;
    }
    if (env.ALERTS_PAUSED && !allowedWhilePaused(msg, cb)) {
      if (cb) { await c.api.answer(cb.id); c.answered = true; }
      await c.api.send(c.chat, pausedText(publicUrl(env)));
      return;
    }
    if (msg) await onMessage(c, msg);
    if (cb) await onCallback(c, cb);
  } catch {
    // onCallback always answers first; never answer the same callback twice.
    if (cb && !c.answered) await c.api.answer(cb.id);
    await c.api.send(c.chat, dbDownText(publicUrl(env)));
  }
}

async function onMessage(c: TgCtx, m: TgMsg): Promise<void> {
  const db = c.env.db;
  const loc = m.location ?? m.venue?.location;
  if (loc && num(loc.latitude) && num(loc.longitude)) {
    // A new location ends any "name this place" wait (final review I2).
    await db.query('UPDATE target SET synced_at = $1, tg_await = NULL WHERE chat_id = $2', [c.now, c.chat]);
    return onLocation(c, loc.latitude, loc.longitude);
  }
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  // Typed coordinates or a map link (Telegram Desktop/Web cannot send a location): a new place,
  // never a name — it ends any wait like a location does.
  const typed = text.startsWith('/') ? null : parseCoords(text);
  if (typed) {
    await db.query('UPDATE target SET synced_at = $1, tg_await = NULL WHERE chat_id = $2', [c.now, c.chat]);
    return onLocation(c, typed.lat, typed.lon, true);
  }
  await db.query('UPDATE target SET synced_at = $1 WHERE chat_id = $2', [c.now, c.chat]);
  // The "จุดที่ติดตาม" key (Plan O spec §4): the list — never a name, and it does not end a wait for one.
  if (text === FOLLOWED_BUTTON_TH) return onList(c);
  const cmd = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i)?.[1]?.toLowerCase() ?? null;
  // The wait is measured from the awaited follow's own created_at: CAPS.tgAwaitMin minutes.
  const t = (await db.query<{ tg_await: string | null; since: Date | null }>('SELECT t.tg_await AS tg_await, f.created_at AS since FROM target t LEFT JOIN follow f ON f.target_id = t.id AND f.key = t.tg_await WHERE t.chat_id = $1', [c.chat])).rows[0];
  const stored = t?.tg_await ?? null;
  const age = t?.since ? c.now.getTime() - t.since.getTime() : Number.NaN;
  const awaiting = stored && age >= 0 && age <= CAPS.tgAwaitMin * 60e3 ? stored : null;
  if (stored && (cmd !== null || !awaiting)) await db.query('UPDATE target SET tg_await = NULL WHERE chat_id = $1', [c.chat]);
  if (cmd !== null) {
    if (cmd === 'start') { await c.api.send(c.chat, START_TH, LOCATION_KEYBOARD); return; }
    if (cmd === 'help') { await c.api.send(c.chat, helpText(publicUrl(c.env)), LOCATION_KEYBOARD); return; }
    if (cmd === 'list') return onList(c);
    if (cmd === 'stop') {
      await c.api.send(c.chat, STOP_CONFIRM_TH, { inline_keyboard: [[{ text: STOP_ALL_BUTTON_TH, callback_data: 'x:all' }, { text: CANCEL_BUTTON_TH, callback_data: 'no' }]] });
      return;
    }
    if (cmd === 'admin' || cmd === 'line' || cmd === 'line_users') {
      if (await onAdminCommand(c, cmd, text)) return;
      // Not the linked admin (spec §4.2): looks exactly like any other unknown command, paused or not.
      await c.api.send(c.chat, c.env.ALERTS_PAUSED ? pausedText(publicUrl(c.env)) : OTHER_TH);
      return;
    }
    if (cmd === 'skip' && awaiting) return onSkip(c, awaiting);
    await c.api.send(c.chat, OTHER_TH);
    return;
  }
  if (awaiting && text) return onLabel(c, awaiting, text);
  await c.api.send(c.chat, OTHER_TH);
}

async function onList(c: TgCtx): Promise<void> {
  const r = (await c.env.db.query<{ id: number; label: string | null; key: string }>('SELECT f.id AS id, f.label AS label, f.key AS key FROM follow f JOIN target t ON t.id = f.target_id WHERE t.chat_id = $1 ORDER BY f.id', [c.chat])).rows;
  if (!r.length) { await c.api.send(c.chat, NO_FOLLOWS_TH); return; }
  const rows = r.map((x) => ({ id: x.id, key: x.key, label: x.label ?? FOLLOW_FALLBACK_LABEL_TH }));
  await c.api.send(c.chat, listText(rows), { inline_keyboard: rows.map((x) => [{ text: viewButtonText(x.label), callback_data: `v:${x.id}` }, { text: UNFOLLOW_BUTTON_TH, callback_data: `u:${x.id}` }]) });
}

async function onSkip(c: TgCtx, key: string): Promise<void> {
  const f = (await c.env.db.query<{ label: string | null }>('SELECT f.label AS label FROM follow f JOIN target t ON t.id = f.target_id WHERE t.chat_id = $1 AND f.key = $2', [c.chat, key])).rows[0];
  await c.api.send(c.chat, f ? skipText(f.label ?? 'จุดที่ติดตาม') : NOT_FOUND_TH);
}

async function onLabel(c: TgCtx, key: string, text: string): Promise<void> {
  const label = tgName(text);
  const db = c.env.db;
  // Nothing usable, or longer than a name (may be a cry for help): the normal reply with the
  // emergency numbers; keep the old label and keep waiting.
  if (!label) { await c.api.send(c.chat, OTHER_TH); return; }
  const r = (await db.query<{ label: string }>('UPDATE follow SET label = $1 WHERE key = $2 AND target_id = (SELECT id FROM target WHERE chat_id = $3) RETURNING label', [label, key, c.chat])).rows[0];
  await db.query('UPDATE target SET tg_await = NULL WHERE chat_id = $1', [c.chat]);
  await c.api.send(c.chat, r ? labelSetText(label) : NOT_FOUND_TH);
}

/** At most CAPS.tgPendingPerChat fresh questions per chat. `fid` (Plan O): the follow a "ดู"
 *  request is for — a question already waiting for that key takes it over, never a second row. */
async function addPending(c: TgCtx, key: string, fid: number | null = null): Promise<'added' | 'full'> {
  const db = c.env.db;
  const cut = new Date(c.now.getTime() - CAPS.tgPendingTtlMin * 60e3);
  await db.query('DELETE FROM tg_pending WHERE chat_id = $1 AND created_at < $2', [c.chat, cut]);
  const r = (await db.query<{ n: number; mine: number }>('SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE key = $1) AS mine FROM tg_pending WHERE chat_id = $2', [key, c.chat])).rows[0];
  if ((r?.mine ?? 0) > 0) {
    if (fid !== null) await db.query('UPDATE tg_pending SET fid = $1 WHERE chat_id = $2 AND key = $3', [fid, c.chat, key]);
    return 'added';
  }
  if ((r?.n ?? 0) >= CAPS.tgPendingPerChat) return 'full';
  await db.query('INSERT INTO tg_pending (chat_id, key, created_at, fid) VALUES ($1, $2, $3, $4) ON CONFLICT (chat_id, key) DO UPDATE SET fid = COALESCE(excluded.fid, tg_pending.fid)', [c.chat, key, c.now, fid]);
  return 'added';
}

/** Stage 1: province overview now; the point's own level from the alerts loop within minutes —
 *  unless the sender is stalled, then no question is queued and nothing is promised (R16). */
async function onLocation(c: TgCtx, lat: number, lon: number, typed = false): Promise<void> {
  // A typed message may also be a cry for help: its reply shows what was read and keeps the
  // emergency numbers (a location from the attach menu cannot carry words).
  if (!inThailand(lat, lon)) { await c.api.send(c.chat, typed ? `${OUTSIDE_TH}\n${NOT_A_REPORT_TH}` : OUTSIDE_TH); return; }
  const key = alertKey(lat, lon);
  const pending = (await alertsStatus(c.env, c.now)) === 'stalled' ? 'stalled' : await addPending(c, key);
  const text = await stage1For(c.env, c.deps, c.now, key, pending);
  const reply = typed ? `${coordsReadText(lat, lon)}\n${text}\n${NOT_A_REPORT_TH}` : text;
  await c.api.send(c.chat, reply, { inline_keyboard: [[{ text: FOLLOW_BUTTON_TH, callback_data: `f:${key}` }, { text: DISMISS_BUTTON_TH, callback_data: 'no' }]] });
}

/** True only for a parseable generatedAt between 0 and AREA_STALE_MIN minutes old. */
function isFreshEnough(now: Date, generatedAt: string): boolean {
  const age = (now.getTime() - Date.parse(generatedAt)) / 60e3;
  return age >= 0 && age <= AREA_STALE_MIN;
}

/** Stage 1's text (Telegram and LINE, Task 6 ruling): the province overview and a line that
 *  promises nothing more than `pending` allows. `timeoutMs` lets LINE keep its own shorter budget
 *  (spec §5.1's 1.5 s per LINE call) while Telegram leaves `provinceArea`'s own default. */
export async function stage1For(env: Env, deps: Deps, now: Date, key: string, pending: Stage1['pending'], timeoutMs?: number): Promise<string> {
  const [klat, klon] = key.split(',').map(Number) as [number, number];
  const prov = provinceFor(klat, klon);
  const area = await provinceArea(env.SITE_URL, prov.code, deps.fetch, timeoutMs);
  return stage1Text({
    area: area ? { name: provinceTitle(prov.code, prov.th), level: area.level, at: area.generatedAt, stale: !isFreshEnough(now, area.generatedAt) } : null,
    pending,
    link: siteLink(publicUrl(env), key),
  });
}

/** Inline buttons: strict formats, always answered. */
async function onCallback(c: TgCtx, cb: TgCallback): Promise<void> {
  await c.api.answer(cb.id);
  c.answered = true;
  const data = typeof cb.data === 'string' ? cb.data : '';
  // String#match, not RegExp#exec (that name collides with tests/server/guards.test.ts's
  // multi-statement-script guard, which is really only meant to catch a Db's exec method);
  // match() is equivalent here since CB.follow/CB.unfollow are non-global regexes.
  const f = data.match(CB.follow);
  if (f) return onFollow(c, f[1]!);
  const u = data.match(CB.unfollow);
  if (u) return onUnfollow(c, Number(u[1]));
  const v = data.match(CB.view);
  if (v) return onView(c, Number(v[1]));
  if (CB.stopAll.test(data)) return onStopAll(c);
  if (CB.dismiss.test(data)) { await c.api.clearButtons(c.chat, cb.message.message_id); return; }
  if (isAdminCallback(data)) { await onAdminCallback(c, data, cb.message.message_id); return; }
}

async function onFollow(c: TgCtx, key: string): Promise<void> {
  const p = parseAlertKey(key);
  if (!p || !inThailand(p.lat, p.lon)) return;
  const db = c.env.db;
  const day = utcDay(c.now);
  const t = (await db.query<{ id: number }>('SELECT id FROM target WHERE chat_id = $1', [c.chat])).rows[0];
  const mine = t ? (await db.query<{ key: string; label: string | null }>('SELECT key, label FROM follow WHERE target_id = $1', [t.id])).rows : [];
  if (mine.some((r) => r.key === key)) { await c.api.send(c.chat, ALREADY_TH); return; }
  if (mine.length >= CAPS.placesPerTarget) { await c.api.send(c.chat, MAX_FOLLOWS_TH); return; }
  const known = (await db.query('SELECT key FROM place WHERE key = $1', [key])).rows.length > 0;
  const newTargets = t ? 0 : 1;
  const newPlaces = known ? 0 : 1;
  // capsAllow is read-then-write, not atomic with the insert below: two concurrent first-time
  // follows can both pass this check before either's addCounts below lands, so the totals can
  // overshoot CAPS by at most the connection pool size — the same accepted, fails-closed race as
  // ratelimit.ts's minuteAndDay (never accepted past the cap for long: the daily cleanup job
  // recomputes the `_total` counters from the tables themselves, so any overshoot self-heals).
  if (!(await capsAllow(db, day, newTargets, newPlaces))) { await c.api.send(c.chat, fullSystemText(publicUrl(c.env))); return; }
  // Per-chat daily cap on NEW follows under its own "tgf" prefix; spent only once the insert succeeds.
  const tgfName = await rateName(c.env.RATE_HMAC_KEY!, 'tgf', String(c.chat));
  const tgf = (await db.query<{ n: number }>('SELECT COALESCE((SELECT n FROM counter WHERE name = $1 AND day = $2), 0) AS n', [tgfName, day])).rows[0];
  if ((tgf?.n ?? 0) >= CAPS.newPlacesPerTargetPerDay) { await c.api.send(c.chat, NEW_FOLLOWS_CAP_TH); return; }
  const label = defaultLabel(mine.map((r) => r.label ?? ''));
  // ON CONFLICT everywhere: a double-tap racing this check-then-insert is "already following", never
  // an error. One transaction end to end: the tg_await/addCounts/tgf writes below only ever land
  // together with the follow itself — a double-tap's loser returns false before touching any of them.
  const created = await db.tx(async (tx) => {
    await tx.query("INSERT INTO target (channel, chat_id, created_at, synced_at) VALUES ('tg', $1, $2, $2) ON CONFLICT (chat_id) DO NOTHING", [c.chat, c.now]);
    await tx.query('INSERT INTO place (key, lat, lon, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING', [key, p.lat, p.lon, c.now]);
    const inserted = (await tx.query('INSERT INTO follow (target_id, key, label, created_at) SELECT id, $1::text, $2::text, $3::timestamptz FROM target WHERE chat_id = $4 ON CONFLICT (target_id, key) DO NOTHING RETURNING id', [key, label, c.now, c.chat])).rows.length > 0;
    if (!inserted) return false;
    await tx.query('UPDATE target SET tg_await = $1, synced_at = $2 WHERE chat_id = $3', [key, c.now, c.chat]);
    await addCounts(tx, day, newTargets, newPlaces);
    await boundedCount(tx, tgfName, day, 1, CAPS.newPlacesPerTargetPerDay);
    return true;
  });
  if (!created) { await c.api.send(c.chat, ALREADY_TH); return; }
  await c.api.send(c.chat, followedText(label));
}

async function onUnfollow(c: TgCtx, fid: number): Promise<void> {
  const db = c.env.db;
  const r = (await db.query<{ label: string | null; key: string }>('DELETE FROM follow WHERE id = $1 AND target_id = (SELECT id FROM target WHERE chat_id = $2) RETURNING label, key', [fid, c.chat])).rows[0];
  if (!r) { await c.api.send(c.chat, NOT_FOUND_TH); return; }
  await db.query('UPDATE target SET tg_await = NULL WHERE chat_id = $1 AND tg_await = $2', [c.chat, r.key]);
  await c.api.send(c.chat, unfollowedText(r.label ?? 'จุดที่ติดตาม'));
}

/** "ดู" (Plan O spec §4): queue the followed place like a location question; the alerts process
 *  answers with the card and its chart. Nothing is promised here, so no message unless it cannot.
 *  Once queued, a NOTIFY moves the alerts process's next tick forward (like LINE, phase-3C spec
 *  §5.2); a NOTIFY that fails is nothing to report — the next regular tick answers. */
async function onView(c: TgCtx, fid: number): Promise<void> {
  const f = (await c.env.db.query<{ key: string }>('SELECT f.key AS key FROM follow f JOIN target t ON t.id = f.target_id WHERE f.id = $1 AND t.chat_id = $2', [fid, c.chat])).rows[0];
  if (!f) { await c.api.send(c.chat, NOT_FOUND_TH); return; }
  if ((await alertsStatus(c.env, c.now)) === 'stalled') { await c.api.send(c.chat, `${STALLED_LINE_TH}\nดูบนเว็บ: ${siteLink(publicUrl(c.env), f.key)}`); return; }
  if ((await addPending(c, f.key, fid)) === 'full') { await c.api.send(c.chat, VIEW_FULL_TH); return; }
  try { await c.env.db.query("SELECT pg_notify('thuammai_wake', '')"); } catch { /* queued: the next regular tick answers */ }
}

async function onStopAll(c: TgCtx): Promise<void> {
  await c.env.db.tx(async (tx) => {
    await tx.query('DELETE FROM target WHERE chat_id = $1', [c.chat]);
    await tx.query('DELETE FROM tg_pending WHERE chat_id = $1', [c.chat]);
  });
  await c.api.send(c.chat, STOPPED_TH);
}
