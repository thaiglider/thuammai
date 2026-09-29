import { BODY_MAX, CAPS } from '../../src/core/alert-config';
import { ALERT_KEY_RE, parseAlertKey } from '../../src/core/alert-key';
import { toIso07 } from '../../src/core/time';
import type { D1Database, Deps, Env } from './env';
import { err, json, readJson, safeEqual } from './http';
import { bad, exactKeys, isObj } from './validate';

export const MAX_ROWS = 2000;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/;
const isId = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0;
const isTime = (x: unknown) => x === null || (typeof x === 'string' && TIME_RE.test(x));

/** /internal/v1/* — only the alerts job (Bearer INTERNAL_TOKEN), no CORS (spec §4). */
export async function internalRoute(req: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  // Not 503: the job reads 503 as "D1 over quota, skip" (green); a missing secret must be loud (m2).
  if (!env.INTERNAL_TOKEN) return err(500, 'not_configured');
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !(await safeEqual(auth.slice(7), env.INTERNAL_TOKEN))) return err(401, 'unauthorized');
  const path = url.pathname.slice('/internal/v1/'.length);
  const db = env.DB;
  if (path === 'places' && req.method === 'GET') return places(db, url);
  if (path === 'state' && req.method === 'GET') return getState(db);
  if (path === 'state' && req.method === 'PUT') return putState(db, await readJson(req, BODY_MAX.internal), deps.now());
  if (path === 'targets' && req.method === 'POST') return targets(db, await readJson(req, BODY_MAX.internal));
  if (path === 'report' && req.method === 'POST') return report(db, await readJson(req, BODY_MAX.internal));
  if (path === 'tg-pending' && req.method === 'GET') return tgPending(db, deps.now());
  return err(404, 'not_found');
}

async function places(db: D1Database, url: URL): Promise<Response> {
  const after = url.searchParams.get('after') ?? '';
  if (after !== '' && !ALERT_KEY_RE.test(after)) throw bad('bad_after');
  const raw = url.searchParams.get('limit');
  const limit = raw === null ? MAX_ROWS : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw bad('bad_limit');
  const r = await db.prepare('SELECT key AS k, lat, lon FROM place WHERE key > ? ORDER BY key LIMIT ?').bind(after, limit).all<{ k: string; lat: number; lon: number }>();
  return json(200, { places: r.results, next: r.results.length === limit ? r.results[r.results.length - 1]!.k : null });
}

async function getState(db: D1Database): Promise<Response> {
  const r = await db.prepare("SELECT version, value FROM kv WHERE name = 'alert_state'").first<{ version: number; value: string }>();
  return json(200, r ?? { version: 0, value: null });
}

async function putState(db: D1Database, body: unknown, now: Date): Promise<Response> {
  if (!isObj(body) || !exactKeys(body, ['version', 'value']) || !Number.isInteger(body.version) || (body.version as number) < 0 || typeof body.value !== 'string') throw bad('bad_state');
  const at = toIso07(now);
  const r = body.version === 0
    ? await db.prepare("INSERT INTO kv (name, version, value, updated_at) VALUES ('alert_state', 1, ?, ?) ON CONFLICT (name) DO NOTHING RETURNING version").bind(body.value, at).first<{ version: number }>()
    : await db.prepare("UPDATE kv SET version = version + 1, value = ?, updated_at = ? WHERE name = 'alert_state' AND version = ? RETURNING version").bind(body.value, at, body.version as number).first<{ version: number }>();
  return r ? json(200, { version: r.version }) : err(409, 'version_conflict');
}

async function targets(db: D1Database, body: unknown): Promise<Response> {
  if (!isObj(body) || !exactKeys(body, ['keys'], ['after'])) throw bad('bad_targets');
  const keys = body.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > CAPS.batch || !keys.every((k) => typeof k === 'string' && ALERT_KEY_RE.test(k))) throw bad('bad_keys');
  const after = body.after ?? 0;
  if (!Number.isInteger(after) || (after as number) < 0) throw bad('bad_after');
  const r = await db.prepare("SELECT f.id AS fid, t.id AS targetId, f.key AS key, t.channel AS ch, f.label AS label, t.endpoint AS endpoint, t.p256dh AS p256dh, t.auth AS auth, t.chat_id AS chat, f.alerted AS alerted, f.last_alert_at AS lastAlertAt, f.last_l4_at AS lastL4At, f.last_clear_at AS lastClearAt FROM follow f JOIN target t ON t.id = f.target_id WHERE f.key IN (SELECT value FROM json_each(?)) AND f.id > ? ORDER BY f.id LIMIT ?").bind(JSON.stringify(keys), after as number, MAX_ROWS).all<{ fid: number }>();
  return json(200, { follows: r.results, next: r.results.length === MAX_ROWS ? r.results[r.results.length - 1]!.fid : null });
}

async function report(db: D1Database, body: unknown): Promise<Response> {
  if (!isObj(body) || !exactKeys(body, ['follows', 'deadTargets', 'donePending'])) throw bad('bad_report');
  const { follows, deadTargets, donePending } = body;
  if (!Array.isArray(follows) || !Array.isArray(deadTargets) || !Array.isArray(donePending)) throw bad('bad_report');
  if (follows.length + deadTargets.length + donePending.length > CAPS.batch) throw bad('too_many');
  for (const f of follows) {
    if (!isObj(f) || !exactKeys(f, ['fid', 'alerted', 'lastAlertAt', 'lastL4At', 'lastClearAt']) || !isId(f.fid)
      || ![0, 3, 4].includes(f.alerted as number) || !isTime(f.lastAlertAt) || !isTime(f.lastL4At) || !isTime(f.lastClearAt)) throw bad('bad_follow');
  }
  if (!deadTargets.every(isId) || !donePending.every(isId)) throw bad('bad_ids');
  const stmts = [];
  if (follows.length) stmts.push(db.prepare("UPDATE follow SET alerted = json_extract(j.value, '$.alerted'), last_alert_at = json_extract(j.value, '$.lastAlertAt'), last_l4_at = json_extract(j.value, '$.lastL4At'), last_clear_at = json_extract(j.value, '$.lastClearAt') FROM json_each(?) AS j WHERE follow.id = json_extract(j.value, '$.fid')").bind(JSON.stringify(follows)));
  if (deadTargets.length) stmts.push(db.prepare('DELETE FROM target WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(deadTargets)));
  if (donePending.length) stmts.push(db.prepare('DELETE FROM tg_pending WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(donePending)));
  if (stmts.length) await db.batch(stmts);
  return json(200, { ok: true });
}

async function tgPending(db: D1Database, now: Date): Promise<Response> {
  const cut = toIso07(new Date(now.getTime() - CAPS.tgPendingTtlMin * 60e3));
  const r = await db.prepare('SELECT id, chat_id AS chat, key AS k, created_at AS createdAt FROM tg_pending WHERE created_at >= ? ORDER BY id LIMIT ?').bind(cut, CAPS.batch).all<{ id: number; chat: number; k: string; createdAt: string }>();
  const pending = r.results.flatMap((x) => {
    const p = parseAlertKey(x.k);
    return p ? [{ id: x.id, chat: x.chat, k: x.k, lat: p.lat, lon: p.lon, createdAt: x.createdAt }] : [];
  });
  return json(200, { pending });
}
