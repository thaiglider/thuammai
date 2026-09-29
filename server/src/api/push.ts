import { BODY_MAX, CAPS, RATE } from '../../../src/core/alert-config';
import { addCounts, boundedCount, capsAllow } from './caps';
import type { Deps, Env } from './env';
import { empty, err, HttpError, json, readJson, safeEqual, toResponse, utcDay, withHeaders } from './http';
import { checkIpRate, rateName, rateOnce, windowKey } from './ratelimit';
import { parseSubscribe, parseUnsubscribe } from './validate';

// Same byte length as a real 16-byte base64url auth secret: a DELETE for an unknown endpoint still
// pays for a comparison (no timing oracle for "does this exist").
const DUMMY_AUTH = 'AAAAAAAAAAAAAAAAAAAAAA';

/** OPTIONS/POST/DELETE /v1/push/subscription — CORS for SITE_ORIGIN only. */
export async function pushRoute(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.headers.get('origin') !== env.SITE_ORIGIN) return err(403, 'forbidden_origin');
  const cors = { 'access-control-allow-origin': env.SITE_ORIGIN, vary: 'Origin' };
  if (req.method === 'OPTIONS') {
    return empty(204, { ...cors, 'access-control-allow-methods': 'POST, DELETE, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '86400' });
  }
  try {
    if (req.method === 'POST') return withHeaders(await subscribe(req, env, deps), cors);
    if (req.method === 'DELETE') return withHeaders(await unsubscribe(req, env, deps), cors);
    return err(405, 'method_not_allowed', cors);
  } catch (e) {
    return withHeaders(toResponse(e), cors);
  }
}

async function subscribe(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (env.ALERTS_PAUSED) return err(503, 'paused');
  const now = deps.now();
  // Parsing is pure CPU on a body already capped at BODY_MAX.public: validate before the rate round trip.
  const body = parseSubscribe(await readJson(req, BODY_MAX.public));
  await checkIpRate(env, deps.ip, now);
  const key = env.RATE_HMAC_KEY;
  if (!key) throw new HttpError(503, 'unavailable');
  const db = env.db;
  const day = utcDay(now);
  const existing = (await db.query<{ id: number; auth: string }>("SELECT id, auth FROM target WHERE endpoint = $1 AND channel = 'push'", [body.endpoint])).rows[0];
  if (existing && !(await safeEqual(existing.auth, body.auth))) return err(409, 'auth_mismatch');

  // The per-target churn throttle counts only once auth has passed (or the target is new), so a
  // wrong-auth flood against someone else's endpoint never spends their hourly budget.
  const subName = await rateName(key, 'sub', body.endpoint);
  const npName = await rateName(key, 'np', body.endpoint);
  const keys = body.places.map((p) => p.key);
  const reads = await db.tx(async (t) => ({
    known: (await t.query('SELECT key FROM place WHERE key = ANY($1::text[])', [keys])).rows.length,
    alreadyFollowed: (await t.query<{ c: number }>('SELECT COUNT(*) AS c FROM follow f JOIN target t ON t.id = f.target_id WHERE t.endpoint = $1 AND f.key = ANY($2::text[])', [body.endpoint, keys])).rows[0]!.c,
    totalFollow: (await t.query<{ c: number }>('SELECT COUNT(*) AS c FROM follow f JOIN target t ON t.id = f.target_id WHERE t.endpoint = $1', [body.endpoint])).rows[0]!.c,
    npCount: (await t.query<{ n: number }>('SELECT COALESCE((SELECT n FROM counter WHERE name = $1 AND day = $2), 0) AS n', [npName, day])).rows[0]!.n,
    subOk: await rateOnce(t, subName, windowKey(now, 'hour'), RATE.subscribePerTargetPerHour),
  }));
  if (!reads.subOk) throw new HttpError(429, 'rate_limited', { 'retry-after': '60' });

  // Same set already followed: skip the rewrite, just refresh synced_at (and p256dh, if it rotated).
  if (existing && reads.totalFollow === body.places.length && reads.alreadyFollowed === body.places.length) {
    await db.query('UPDATE target SET p256dh = $1, synced_at = $2 WHERE id = $3', [body.p256dh, now, existing.id]);
    return json(200, { ok: true, places: body.places.length });
  }

  const newPlaces = body.places.length - reads.known;
  const newTargets = existing ? 0 : 1;
  const newToTarget = body.places.length - reads.alreadyFollowed;
  if (!(await capsAllow(db, day, newTargets, newPlaces))) return err(503, 'full');
  if (newToTarget > 0 && reads.npCount + newToTarget > CAPS.newPlacesPerTargetPerDay) return err(429, 'too_many_places');

  await db.tx(async (t) => {
    let id: number;
    if (existing) {
      await t.query('UPDATE target SET p256dh = $1, synced_at = $2 WHERE id = $3', [body.p256dh, now, existing.id]);
      id = existing.id;
    } else {
      id = (await t.query<{ id: number }>("INSERT INTO target (channel, endpoint, p256dh, auth, created_at, synced_at) VALUES ('push', $1, $2, $3, $4, $4) RETURNING id", [body.endpoint, body.p256dh, body.auth, now])).rows[0]!.id;
    }
    // ORDER BY u.k: concurrent subscribes insert shared new places in one order (no deadlock).
    await t.query('INSERT INTO place (key, lat, lon, created_at) SELECT u.k, u.lat, u.lon, $4::timestamptz FROM unnest($1::text[], $2::float8[], $3::float8[]) AS u(k, lat, lon) ORDER BY u.k ON CONFLICT (key) DO NOTHING', [keys, body.places.map((p) => p.lat), body.places.map((p) => p.lon), now]);
    // Replace the whole set; follows that stay keep alerted/last_* (no repeat alert after a rename).
    if (existing) await t.query('DELETE FROM follow WHERE target_id = $1 AND NOT (key = ANY($2::text[]))', [id, keys]);
    await t.query('INSERT INTO follow (target_id, key, created_at) SELECT $1::bigint, k, $2::timestamptz FROM unnest($3::text[]) AS k ON CONFLICT (target_id, key) DO NOTHING', [id, now, keys]);
    await addCounts(t, day, newTargets, newPlaces);
    if (newToTarget > 0) await boundedCount(t, npName, day, newToTarget, CAPS.newPlacesPerTargetPerDay);
  });
  return json(200, { ok: true, places: body.places.length });
}

async function unsubscribe(req: Request, env: Env, deps: Deps): Promise<Response> {
  await checkIpRate(env, deps.ip, deps.now());
  const b = parseUnsubscribe(await readJson(req, BODY_MAX.public));
  const t = (await env.db.query<{ id: number; auth: string }>("SELECT id, auth FROM target WHERE endpoint = $1 AND channel = 'push'", [b.endpoint])).rows[0];
  // Always pay for the comparison, even when there is nothing to compare against (constant work).
  const match = await safeEqual(t?.auth ?? DUMMY_AUTH, b.auth);
  if (t && match) await env.db.query('DELETE FROM target WHERE id = $1', [t.id]);
  return empty(204); // always: no oracle for "does this endpoint exist"
}
