import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { relaySigOk } from '../../../src/core/relay-sig';
import { validCanal, validRoad, validTime07 } from '../../../src/core/relay-validate';
import type { RelayPayload } from '../../../src/core/relay-types';
import type { Deps, Env } from './env';
import { empty, err, HttpError, json, readBody, safeEqual } from './http';
import { counterRate } from './ratelimit';
import { exactKeys, isObj } from './validate';

export const RELAY = { gzipMax: 65_536, inflatedMax: 1_048_576, skewSec: 300, itemsMax: 2000, postPerMin: 30, getPerMin: 60 } as const;
const gunzipAsync = promisify(gunzip) as (b: Uint8Array, o: { maxOutputLength: number }) => Promise<Buffer>;
const bad = (): HttpError => new HttpError(400, 'bad_payload');

const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;

/** Strict schema of a relay report; throws 400 bad_payload. One bad item rejects the whole report
 *  (the relay drops bad items itself before sending). `error` is an optional short reason. */
export function parseRelayPayload(x: unknown): RelayPayload {
  if (!isObj(x) || !exactKeys(x, ['v', 'fetchedAt', 'road', 'canal'], ['error']) || x.v !== 1 || !validTime07(x.fetchedAt)) throw bad();
  const { road, canal } = x;
  if (!Array.isArray(road) || !Array.isArray(canal) || road.length > RELAY.itemsMax || canal.length > RELAY.itemsMax) throw bad();
  if (x.error !== undefined && !str(x.error, 200)) throw bad();
  if (!road.every(validRoad) || !canal.every(validCanal)) throw bad();
  return x as unknown as RelayPayload;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

/** POST/GET /v1/relay/bma (Plan M spec §3). Server-to-server: no CORS. Never logs bodies or secrets. */
export async function relayRoute(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.method !== 'POST' && req.method !== 'GET') return err(405, 'method_not_allowed');
  if (!env.RELAY_HMAC_KEY || !env.RELAY_READ_TOKEN) return err(503, 'relay_off');
  const post = req.method === 'POST';
  if (!(await counterRate(env, post ? 'relayp' : 'relayg', deps.ip, post ? RELAY.postPerMin : RELAY.getPerMin, deps.now()))) throw new HttpError(429, 'rate_limited', { 'retry-after': '60' });
  return post ? relayPost(req, env, deps.now()) : relayGet(req, env);
}


async function relayPost(req: Request, env: Env, now: Date): Promise<Response> {
  if ((req.headers.get('content-encoding') ?? '').toLowerCase() !== 'gzip') throw new HttpError(415, 'unsupported_media_type');
  const gz = await readBody(req, RELAY.gzipMax);
  const ts = req.headers.get('x-relay-time') ?? '';
  if (!/^\d{1,12}$/.test(ts)) throw new HttpError(401, 'unauthorized');
  const time = Number(ts);
  if (Math.abs(now.getTime() / 1000 - time) > RELAY.skewSec) throw new HttpError(401, 'unauthorized');
  if (!relaySigOk(env.RELAY_HMAC_KEY!, time, gz, req.headers.get('x-relay-sig') ?? '')) throw new HttpError(401, 'unauthorized');
  let p: RelayPayload;
  try {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await gunzipAsync(gz, { maxOutputLength: RELAY.inflatedMax })); } catch { throw new HttpError(400, 'bad_gzip'); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new HttpError(400, 'bad_json'); }
    p = parseRelayPayload(parsed);
    if (p.road.length === 0 && p.canal.length === 0 && p.error === undefined) throw bad(); // empty and no reason
  } catch (e) {
    // A validly signed report we refuse still shows the relay is alive: GET says "rejected: <code>".
    if (e instanceof HttpError) await recordError(env, time, now, `rejected: ${e.code}`);
    throw e;
  }
  const at = now.toISOString();
  const hasData = p.road.length > 0 || p.canal.length > 0;
  if (!hasData) {
    if (!(await recordError(env, time, now, p.error!))) throw new HttpError(409, 'replay');
    return empty(204);
  }
  // Data (with or without a note about the other side): stored without the error key, which lives in last_error.
  const { error, ...stored } = p;
  // One atomic statement: the row is only touched when this time is strictly newer (replay guard).
  const r = await env.db.query("INSERT INTO relay_blob (name, received_at, fetched_at, relay_time, body, last_report_at, last_error) VALUES ('bma', $1, $2, $3, $4::jsonb, $1, $5) ON CONFLICT (name) DO UPDATE SET received_at = excluded.received_at, fetched_at = excluded.fetched_at, relay_time = excluded.relay_time, body = excluded.body, last_report_at = excluded.last_report_at, last_error = excluded.last_error WHERE relay_blob.relay_time < excluded.relay_time RETURNING name", [at, p.fetchedAt, time, JSON.stringify(stored), error ?? null]);
  if (r.rows.length === 0) throw new HttpError(409, 'replay');
  return empty(204);
}

/** Record that the relay reported (or was refused) with `message`, keeping any stored good body. False on replay. */
async function recordError(env: Env, time: number, now: Date, message: string): Promise<boolean> {
  const r = await env.db.query("INSERT INTO relay_blob (name, relay_time, last_report_at, last_error) VALUES ('bma', $1, $2, $3) ON CONFLICT (name) DO UPDATE SET relay_time = excluded.relay_time, last_report_at = excluded.last_report_at, last_error = excluded.last_error WHERE relay_blob.relay_time < excluded.relay_time RETURNING name", [time, now.toISOString(), message]);
  return r.rows.length > 0;
}

async function relayGet(req: Request, env: Env): Promise<Response> {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer (\S+)$/);
  if (!m || !(await safeEqual(m[1]!, env.RELAY_READ_TOKEN!))) throw new HttpError(401, 'unauthorized');
  const row = (await env.db.query<{ body: unknown; received_at: unknown; last_report_at: unknown; last_error: string | null }>("SELECT body, received_at, last_report_at, last_error FROM relay_blob WHERE name = 'bma'")).rows[0];
  if (!row) return err(404, 'no_data');
  // No good body yet (only error reports so far): an empty payload with fetchedAt null, plus the metadata.
  const body = isObj(row.body) ? row.body : { v: 1, fetchedAt: null, road: [], canal: [] };
  return json(200, { ...body, receivedAt: iso(row.received_at), lastReportAt: iso(row.last_report_at), lastError: row.last_error });
}
