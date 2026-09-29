import { BODY_MAX, CAPS, RATE } from '../../src/core/alert-config';
import { toIso07 } from '../../src/core/time';
import { boundedCountStmt, capsAllow, countStatements } from './caps';
import type { Deps, Env } from './env';
import { empty, err, HttpError, json, readJson, safeEqual, toResponse, utcDay, withHeaders } from './http';
import { checkIpRate, rateName, rateStmt, windowKey } from './ratelimit';
import { parseSubscribe, parseUnsubscribe } from './validate';

// Same byte length as a real 16-byte base64url auth secret; used so a DELETE for an unknown
// endpoint still pays for a safeEqual comparison (spec §8: no timing oracle for "does this exist").
const DUMMY_AUTH = 'AAAAAAAAAAAAAAAAAAAAAA';

/** POST/DELETE/OPTIONS /v1/push/subscription — the only routes with CORS, for SITE_ORIGIN only. */
export async function pushRoute(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.headers.get('origin') !== env.SITE_ORIGIN) return err(403, 'forbidden_origin');
  const cors = { 'access-control-allow-origin': env.SITE_ORIGIN, vary: 'Origin' };
  if (req.method === 'OPTIONS') {
    return empty(204, { ...cors, 'access-control-allow-methods': 'POST, DELETE, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '86400' });
  }
  try {
    if (req.method === 'POST') return withHeaders(await subscribe(req, env, deps.now()), cors);
    if (req.method === 'DELETE') return withHeaders(await unsubscribe(req, env, deps.now()), cors);
    return err(405, 'method_not_allowed', cors);
  } catch (e) {
    return withHeaders(toResponse(e), cors);
  }
}

async function subscribe(req: Request, env: Env, now: Date): Promise<Response> {
  // Deliberate: parsing is pure CPU (no D1) and the body is already capped at BODY_MAX.public
  // bytes, so validating before the rate-limit round trip costs nothing and saves a wasted one
  // on malformed bodies — an attacker gains nothing by racing the rate limit with garbage JSON.
  const body = parseSubscribe(await readJson(req, BODY_MAX.public));
  // Per-IP only here (spec §4): per-minute burst cap and a per-day cap, in one round trip (and,
  // once the IP is already over its day cap, that one round trip writes nothing at all — see
  // checkIpRate's own docstring). The per-target "sub" throttle is checked further down, only once
  // auth has passed (see below).
  await checkIpRate(req, env, now);

  const db = env.DB;
  const at = toIso07(now);
  const day = utcDay(now);
  const existing = await db.prepare("SELECT id, auth FROM target WHERE endpoint = ? AND channel = 'push'").bind(body.endpoint).first<{ id: number; auth: string }>();
  if (existing && !(await safeEqual(existing.auth, body.auth))) return err(409, 'auth_mismatch');

  // The per-target churn throttle is only counted from here on: auth has now passed (or this is a
  // brand-new target), so a wrong-auth flood against someone else's endpoint can never spend their
  // hourly budget and lock them out of their own resync. Folded into the same batch as the other
  // per-target reads below, so this still costs one round trip, not a separate one.
  const subName = await rateName(env.INTERNAL_TOKEN!, 'sub', body.endpoint);
  const keysJson = JSON.stringify(body.places.map((p) => p.key));
  const npName = await rateName(env.INTERNAL_TOKEN!, 'np', body.endpoint);
  const reads = await db.batch([
    db.prepare('SELECT key FROM place WHERE key IN (SELECT value FROM json_each(?))').bind(keysJson),
    db.prepare('SELECT COUNT(*) AS c FROM follow f JOIN target t ON t.id = f.target_id WHERE t.endpoint = ? AND f.key IN (SELECT value FROM json_each(?))').bind(body.endpoint, keysJson),
    db.prepare('SELECT COUNT(*) AS c FROM follow f JOIN target t ON t.id = f.target_id WHERE t.endpoint = ?').bind(body.endpoint),
    db.prepare('SELECT COALESCE((SELECT n FROM counter WHERE name = ? AND day = ?), 0) AS n').bind(npName, day),
    rateStmt(env, subName, windowKey(now, 'hour'), RATE.subscribePerTargetPerHour),
  ]);
  const known = reads[0]!.results.length;
  const alreadyFollowed = (reads[1]!.results[0] as { c: number }).c;
  const totalFollow = (reads[2]!.results[0] as { c: number }).c;
  const npCount = (reads[3]!.results[0] as { n: number }).n;
  // Empty RETURNING (not a numeric comparison) is the only "blocked" signal — see rateStmt's
  // docstring for why: it's what lets the SQL itself stop writing once already at the limit.
  if (reads[4]!.results.length === 0) throw new HttpError(429, 'rate_limited', { 'retry-after': '60' });

  // Same set already followed by this target: skip the rewrite entirely (write amplification),
  // just refresh synced_at (and p256dh, in case it rotated) so the 180-day sweep leaves it alone.
  const unchanged = !!existing && totalFollow === body.places.length && alreadyFollowed === body.places.length;
  if (unchanged) {
    await db.prepare('UPDATE target SET p256dh = ?, synced_at = ? WHERE id = ?').bind(body.p256dh, at, existing!.id).run();
    return json(200, { ok: true, places: body.places.length });
  }

  const newPlaces = body.places.length - known;
  const newTargets = existing ? 0 : 1;
  const newToTarget = body.places.length - alreadyFollowed;
  if (!(await capsAllow(db, day, newTargets, newPlaces))) return err(503, 'full');
  if (newToTarget > 0 && npCount + newToTarget > CAPS.newPlacesPerTargetPerDay) return err(429, 'too_many_places');

  const placesJson = JSON.stringify(body.places.map((p) => ({ k: p.key, lat: p.lat, lon: p.lon })));
  await db.batch([
    existing
      ? db.prepare('UPDATE target SET p256dh = ?, synced_at = ? WHERE id = ?').bind(body.p256dh, at, existing.id)
      : db.prepare("INSERT INTO target (channel, endpoint, p256dh, auth, created_at, synced_at) VALUES ('push', ?, ?, ?, ?, ?)").bind(body.endpoint, body.p256dh, body.auth, at, at),
    db.prepare("INSERT OR IGNORE INTO place (key, lat, lon, created_at) SELECT json_extract(value, '$.k'), json_extract(value, '$.lat'), json_extract(value, '$.lon'), ? FROM json_each(?)").bind(at, placesJson),
    // Replace the whole set; follows that stay keep alerted/last_* (no repeat alert after a rename).
    ...(existing
      ? [
          db.prepare('DELETE FROM follow WHERE target_id = ? AND key NOT IN (SELECT value FROM json_each(?))').bind(existing.id, keysJson),
          db.prepare('INSERT OR IGNORE INTO follow (target_id, key, created_at) SELECT ?, value, ? FROM json_each(?)').bind(existing.id, at, keysJson),
        ]
      : [
          db.prepare('DELETE FROM follow WHERE target_id = (SELECT id FROM target WHERE endpoint = ?) AND key NOT IN (SELECT value FROM json_each(?))').bind(body.endpoint, keysJson),
          db.prepare('INSERT OR IGNORE INTO follow (target_id, key, created_at) SELECT t.id, j.value, ? FROM target t, json_each(?) j WHERE t.endpoint = ?').bind(at, keysJson, body.endpoint),
        ]),
    ...countStatements(db, day, newTargets, newPlaces),
    ...(newToTarget > 0 ? [boundedCountStmt(db, npName, day, newToTarget, CAPS.newPlacesPerTargetPerDay)] : []),
  ]);
  return json(200, { ok: true, places: body.places.length });
}

async function unsubscribe(req: Request, env: Env, now: Date): Promise<Response> {
  await checkIpRate(req, env, now);
  const b = parseUnsubscribe(await readJson(req, BODY_MAX.public));
  const t = await env.DB.prepare("SELECT id, auth FROM target WHERE endpoint = ? AND channel = 'push'").bind(b.endpoint).first<{ id: number; auth: string }>();
  // Always pay for the comparison, even when there is nothing to compare against (constant work).
  const match = await safeEqual(t?.auth ?? DUMMY_AUTH, b.auth);
  if (t && match) await env.DB.prepare('DELETE FROM target WHERE id = ?').bind(t.id).run();
  return empty(204); // always: no oracle for "does this endpoint exist"
}
