import { BODY_MAX, CAPS, RATE } from '../../src/core/alert-config';
import { alertKey, parseAlertKey } from '../../src/core/alert-key';
import { inThailand } from '../../src/core/geo';
import { toIso07 } from '../../src/core/time';
import {
  ALREADY_TH, CANCEL_BUTTON_TH, CB, dbDownText, defaultLabel, DISMISS_BUTTON_TH, FOLLOW_BUTTON_TH, followedText, fullSystemText,
  helpText, labelSetText, listText, MAX_FOLLOWS_TH, NEW_FOLLOWS_CAP_TH, NO_FOLLOWS_TH, NOT_FOUND_TH,
  OTHER_TH, OUTSIDE_TH, provinceTitle, SEND_LOCATION_TH, siteLink, skipText, stage1Text, START_TH, STOP_ALL_BUTTON_TH, STOP_CONFIRM_TH,
  STOPPED_TH, tgName, unfollowButtonText, unfollowedText,
} from '../../src/core/tg-text';
import { provinceArea, provinceFor } from './areas';
import { boundedCountStmt, capsAllow, countStatements } from './caps';
import type { Deps, Env } from './env';
import { err, json, readJson, safeEqual, utcDay } from './http';
import { counterRate, counterRateDaily, rateName } from './ratelimit';
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
export interface TgCtx { env: Env; deps: Deps; api: TgApi; chat: number; now: Date; at: string; answered: boolean }

export const LOCATION_KEYBOARD: ReplyMarkup = { keyboard: [[{ text: SEND_LOCATION_TH, request_location: true }]], resize_keyboard: true };
const AREA_STALE_MIN = 180;

/** POST /v1/telegram (spec §4, §7). 200 whenever the secret is right, so Telegram never resends. */
export async function telegramRoute(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  // INTERNAL_TOKEN is the HMAC key counterRateDaily (and the "tgf" new-follows counter) use to
  // hash the per-chat rate counters below (chat ids are never stored raw in `counter` rows) — so
  // it must be present too, not just the two Telegram secrets.
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.INTERNAL_TOKEN) return err(503, 'unavailable');
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
/** `/stop` and its "ลบทั้งหมด" button: a chat must always be able to delete its data, so these
 *  skip the per-chat DAY cap (the minute cap still applies) — final review M4. */
const isDeletion = (msg: TgMsg | null, cb: TgCallback | null): boolean =>
  (msg !== null && typeof msg.text === 'string' && STOP_CMD_RE.test(msg.text.trim())) ||
  (cb !== null && typeof cb.data === 'string' && CB.stopAll.test(cb.data));

export async function handleUpdate(update: unknown, env: Env, deps: Deps): Promise<void> {
  if (!isObj(update)) return;
  const msg = asMsg(update.message);
  const cb = asCallback(update.callback_query);
  const chat = msg?.chat ?? cb?.message.chat;
  if (!chat || chat.type !== 'private') return; // groups and channels: ignored (spec §7.1)
  const now = deps.now();
  const c: TgCtx = { env, deps, api: tgApi(env.TELEGRAM_BOT_TOKEN!, deps.fetch), chat: chat.id, now, at: toIso07(now), answered: false };
  try {
    // Minute burst cap AND a day cap (security review: a follow/unfollow loop at the minute cap
    // alone could still write ~28,800 counter rows/day from one chat) in one round trip.
    const allowed = isDeletion(msg, cb)
      ? await counterRate(env, 'tg', String(chat.id), RATE.tgUpdatesPerChatPerMin, now, 'minute')
      : await counterRateDaily(env, 'tg', String(chat.id), RATE.tgUpdatesPerChatPerMin, RATE.tgUpdatesPerChatPerDay, now);
    if (!allowed) {
      if (cb) { await c.api.answer(cb.id); c.answered = true; }
      return;
    }
    if (msg) await onMessage(c, msg);
    if (cb) await onCallback(c, cb);
  } catch {
    // onCallback always answers first, before doing any D1 write — if a failure happens after
    // that, don't answer the same callback twice (security review #3).
    if (cb && !c.answered) await c.api.answer(cb.id);
    await c.api.send(c.chat, dbDownText(env.SITE_URL));
  }
}

async function onMessage(c: TgCtx, m: TgMsg): Promise<void> {
  const db = c.env.DB;
  const loc = m.location ?? m.venue?.location;
  if (loc && num(loc.latitude) && num(loc.longitude)) {
    // A new location ends any "name this place" wait (final review I2).
    await db.prepare('UPDATE target SET synced_at = ?, tg_await = NULL WHERE chat_id = ?').bind(c.at, c.chat).run();
    return onLocation(c, loc.latitude, loc.longitude);
  }
  await db.prepare('UPDATE target SET synced_at = ? WHERE chat_id = ?').bind(c.at, c.chat).run();
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  const cmd = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase() ?? null;
  // The wait is measured from the awaited follow's own created_at (no extra column): it lasts
  // CAPS.tgAwaitMin minutes, so text typed hours or days later is never taken as a name.
  const t = await db.prepare('SELECT t.tg_await AS tg_await, f.created_at AS since FROM target t LEFT JOIN follow f ON f.target_id = t.id AND f.key = t.tg_await WHERE t.chat_id = ?').bind(c.chat).first<{ tg_await: string | null; since: string | null }>();
  const stored = t?.tg_await ?? null;
  const age = t?.since ? c.now.getTime() - Date.parse(t.since) : Number.NaN;
  const awaiting = stored && age >= 0 && age <= CAPS.tgAwaitMin * 60e3 ? stored : null;
  if (stored && (cmd !== null || !awaiting)) await db.prepare('UPDATE target SET tg_await = NULL WHERE chat_id = ?').bind(c.chat).run();
  if (cmd !== null) {
    if (cmd === 'start') { await c.api.send(c.chat, START_TH, LOCATION_KEYBOARD); return; }
    if (cmd === 'help') { await c.api.send(c.chat, helpText(c.env.SITE_URL)); return; }
    if (cmd === 'list') return onList(c);
    if (cmd === 'stop') {
      await c.api.send(c.chat, STOP_CONFIRM_TH, { inline_keyboard: [[{ text: STOP_ALL_BUTTON_TH, callback_data: 'x:all' }, { text: CANCEL_BUTTON_TH, callback_data: 'no' }]] });
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
  const r = await c.env.DB.prepare('SELECT f.id AS id, f.label AS label, f.key AS key FROM follow f JOIN target t ON t.id = f.target_id WHERE t.chat_id = ? ORDER BY f.id').bind(c.chat).all<{ id: number; label: string | null; key: string }>();
  if (!r.results.length) { await c.api.send(c.chat, NO_FOLLOWS_TH); return; }
  const rows = r.results.map((x) => ({ id: x.id, key: x.key, label: x.label ?? 'จุดที่ติดตาม' }));
  await c.api.send(c.chat, listText(rows), { inline_keyboard: rows.map((x) => [{ text: unfollowButtonText(x.label), callback_data: `u:${x.id}` }]) });
}

async function onSkip(c: TgCtx, key: string): Promise<void> {
  const f = await c.env.DB.prepare('SELECT f.label AS label FROM follow f JOIN target t ON t.id = f.target_id WHERE t.chat_id = ? AND f.key = ?').bind(c.chat, key).first<{ label: string | null }>();
  await c.api.send(c.chat, f ? skipText(f.label ?? 'จุดที่ติดตาม') : NOT_FOUND_TH);
}

async function onLabel(c: TgCtx, key: string, text: string): Promise<void> {
  const label = tgName(text);
  const db = c.env.DB;
  // Nothing usable, or longer than a name (may be a cry for help): the normal reply with the
  // emergency numbers; keep the old label and keep waiting (until the wait expires).
  if (!label) { await c.api.send(c.chat, OTHER_TH); return; }
  const r = await db.prepare('UPDATE follow SET label = ? WHERE key = ? AND target_id = (SELECT id FROM target WHERE chat_id = ?) RETURNING label').bind(label, key, c.chat).first<{ label: string }>();
  await db.prepare('UPDATE target SET tg_await = NULL WHERE chat_id = ?').bind(c.chat).run();
  await c.api.send(c.chat, r ? labelSetText(label) : NOT_FOUND_TH);
}

/** At most CAPS.tgPendingPerChat fresh questions per chat (ruling 4). */
async function addPending(c: TgCtx, key: string): Promise<'added' | 'full'> {
  const db = c.env.DB;
  const cut = toIso07(new Date(c.now.getTime() - CAPS.tgPendingTtlMin * 60e3));
  await db.prepare('DELETE FROM tg_pending WHERE chat_id = ? AND created_at < ?').bind(c.chat, cut).run();
  const r = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(key = ?), 0) AS mine FROM tg_pending WHERE chat_id = ?').bind(key, c.chat).first<{ n: number; mine: number }>();
  if ((r?.mine ?? 0) > 0) return 'added';
  if ((r?.n ?? 0) >= CAPS.tgPendingPerChat) return 'full';
  await db.prepare('INSERT OR IGNORE INTO tg_pending (chat_id, key, created_at) VALUES (?, ?, ?)').bind(c.chat, key, c.at).run();
  return 'added';
}

/** Stage 1 (spec §7.2): province overview now, the point's own level from the next alerts run. */
async function onLocation(c: TgCtx, lat: number, lon: number): Promise<void> {
  if (!inThailand(lat, lon)) { await c.api.send(c.chat, OUTSIDE_TH); return; }
  const key = alertKey(lat, lon);
  const pending = await addPending(c, key);
  const [klat, klon] = key.split(',').map(Number) as [number, number];
  const prov = provinceFor(klat, klon);
  const area = await provinceArea(c.env.SITE_URL, prov.code, c.deps.fetch, c.deps.cache ?? null);
  const text = stage1Text({
    area: area ? { name: provinceTitle(prov.code, prov.th), level: area.level, at: area.generatedAt, stale: !isFreshEnough(c.now, area.generatedAt) } : null,
    pending,
    link: siteLink(c.env.SITE_URL, key),
  });
  await c.api.send(c.chat, text, { inline_keyboard: [[{ text: FOLLOW_BUTTON_TH, callback_data: `f:${key}` }, { text: DISMISS_BUTTON_TH, callback_data: 'no' }]] });
}

/** True only for a `generatedAt` that parses AND is between 0 and AREA_STALE_MIN minutes old.
 *  Both an unparseable string (`Date.parse` → NaN, every comparison with it is false) and a
 *  generatedAt in the future (negative age) fail the `age >= 0` half and are treated as stale —
 *  never silently shown as fresh data (security review #4). */
function isFreshEnough(now: Date, generatedAt: string): boolean {
  const age = (now.getTime() - Date.parse(generatedAt)) / 60e3;
  return age >= 0 && age <= AREA_STALE_MIN;
}

/** Inline buttons (spec §7.3): strict formats, always answered (ruling 8). */
async function onCallback(c: TgCtx, cb: TgCallback): Promise<void> {
  await c.api.answer(cb.id);
  c.answered = true;
  const data = typeof cb.data === 'string' ? cb.data : '';
  const f = CB.follow.exec(data);
  if (f) return onFollow(c, f[1]!);
  const u = CB.unfollow.exec(data);
  if (u) return onUnfollow(c, Number(u[1]));
  if (CB.stopAll.test(data)) return onStopAll(c);
  if (CB.dismiss.test(data)) { await c.api.clearButtons(c.chat, cb.message.message_id); return; }
}

async function onFollow(c: TgCtx, key: string): Promise<void> {
  const p = parseAlertKey(key);
  if (!p || !inThailand(p.lat, p.lon)) return;
  const db = c.env.DB;
  const day = utcDay(c.now);
  const t = await db.prepare('SELECT id FROM target WHERE chat_id = ?').bind(c.chat).first<{ id: number }>();
  const mine = t ? (await db.prepare('SELECT key, label FROM follow WHERE target_id = ?').bind(t.id).all<{ key: string; label: string | null }>()).results : [];
  if (mine.some((r) => r.key === key)) { await c.api.send(c.chat, ALREADY_TH); return; }
  if (mine.length >= CAPS.placesPerTarget) { await c.api.send(c.chat, MAX_FOLLOWS_TH); return; }
  const known = await db.prepare('SELECT key FROM place WHERE key = ?').bind(key).first<{ key: string }>();
  const newTargets = t ? 0 : 1;
  const newPlaces = known ? 0 : 1;
  if (!(await capsAllow(db, day, newTargets, newPlaces))) { await c.api.send(c.chat, fullSystemText(c.env.SITE_URL)); return; }
  // Per-chat daily cap on NEW follows (security review #1b): an HMAC of the chat id under its own
  // "tgf" prefix (never the same hash as the "tg" per-chat update counter above), read here and
  // only actually spent below once the follow insert itself succeeds.
  const tgfName = await rateName(c.env.INTERNAL_TOKEN!, 'tgf', String(c.chat));
  const tgf = await db.prepare('SELECT COALESCE((SELECT n FROM counter WHERE name = ? AND day = ?), 0) AS n').bind(tgfName, day).first<{ n: number }>();
  if ((tgf?.n ?? 0) >= CAPS.newPlacesPerTargetPerDay) { await c.api.send(c.chat, NEW_FOLLOWS_CAP_TH); return; }
  const label = defaultLabel(mine.map((r) => r.label ?? ''));
  // `OR IGNORE` on target/place and `ON CONFLICT ... DO NOTHING` on follow (security review #2):
  // a double-tap or two concurrent presses racing this same check-then-insert must never surface
  // as a D1 constraint error (→ the "ขัดข้อง" reply) — an empty RETURNING here means "someone else's
  // request already created this follow", answered the same as any other already-following case.
  const results = await db.batch([
    db.prepare("INSERT OR IGNORE INTO target (channel, chat_id, created_at, synced_at) VALUES ('tg', ?, ?, ?)").bind(c.chat, c.at, c.at),
    db.prepare('INSERT OR IGNORE INTO place (key, lat, lon, created_at) VALUES (?, ?, ?, ?)').bind(key, p.lat, p.lon, c.at),
    db.prepare('INSERT INTO follow (target_id, key, label, created_at) SELECT id, ?, ?, ? FROM target WHERE chat_id = ? ON CONFLICT (target_id, key) DO NOTHING RETURNING id').bind(key, label, c.at, c.chat),
  ]);
  if (results[2]!.results.length === 0) { await c.api.send(c.chat, ALREADY_TH); return; }
  await db.batch([
    db.prepare('UPDATE target SET tg_await = ?, synced_at = ? WHERE chat_id = ?').bind(key, c.at, c.chat),
    ...countStatements(db, day, newTargets, newPlaces),
    boundedCountStmt(db, tgfName, day, 1, CAPS.newPlacesPerTargetPerDay),
  ]);
  await c.api.send(c.chat, followedText(label));
}

async function onUnfollow(c: TgCtx, fid: number): Promise<void> {
  const db = c.env.DB;
  const r = await db.prepare('DELETE FROM follow WHERE id = ? AND target_id = (SELECT id FROM target WHERE chat_id = ?) RETURNING label, key').bind(fid, c.chat).first<{ label: string | null; key: string }>();
  if (!r) { await c.api.send(c.chat, NOT_FOUND_TH); return; }
  await db.prepare('UPDATE target SET tg_await = NULL WHERE chat_id = ? AND tg_await = ?').bind(c.chat, r.key).run();
  await c.api.send(c.chat, unfollowedText(r.label ?? 'จุดที่ติดตาม'));
}

async function onStopAll(c: TgCtx): Promise<void> {
  const db = c.env.DB;
  await db.batch([
    db.prepare('DELETE FROM target WHERE chat_id = ?').bind(c.chat),
    db.prepare('DELETE FROM tg_pending WHERE chat_id = ?').bind(c.chat),
  ]);
  await c.api.send(c.chat, STOPPED_TH);
}
