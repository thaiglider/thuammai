import { pathToFileURL } from 'node:url';
import { lineLimit, lineMonth, lineUsed } from '../../../src/alerts/line-budget';
import { LINE } from '../../../src/core/alert-config';
import { dbConn } from '../api/config';
import type { Db } from '../db/db';
import { createPool, poolDb } from '../db/pg';
import { lineCounts, readLineUsage } from '../line/store';
import { fileSecrets } from '../secrets';

/* thuammai line token|status and the LINE part of finish/resume (phase-3C spec §9). `check` and `set`
 * run in the tools container (egress, the token only); `status` runs in the api container (database). */

/** LINE said no for good (401/403) or the token is malformed: the host keeps the previous pair (G-16). */
export class LineRejected extends Error {}
export const EXIT_REJECTED = 3;
const TOKEN_RE = /^[\x21-\x7e]{20,1000}$/;

function checkToken(token: string): void {
  if (!TOKEN_RE.test(token)) throw new LineRejected('LINE_CHANNEL_TOKEN is missing or malformed');
}
/** The token is only ever in the Authorization header, never in an error message. */
async function call(token: string, fetchImpl: typeof fetch, method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetchImpl(`https://api.line.me${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 401 || r.status === 403) throw new LineRejected(`LINE rejected the channel access token (${r.status})`);
  return { status: r.status, json };
}

export async function lineCheck(o: { token?: string; fetchImpl?: typeof fetch }): Promise<string> {
  const token = o.token ?? '';
  checkToken(token);
  const r = await call(token, o.fetchImpl ?? fetch, 'GET', '/v2/bot/info');
  if (r.status !== 200 || typeof r.json.basicId !== 'string') throw new Error(`bot info failed: ${r.status}`);
  return r.json.basicId;
}

export async function lineSetWebhook(o: { token?: string; origin?: string; fetchImpl?: typeof fetch }): Promise<{ endpoint: string; test: string }> {
  const token = o.token ?? '';
  checkToken(token);
  const origin = o.origin ?? '';
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) throw new Error('API_HOST must be a host name (the origin is https://<API_HOST>)');
  const endpoint = `${origin}/v1/line`;
  const f = o.fetchImpl ?? fetch;
  const s = await call(token, f, 'PUT', '/v2/bot/channel/webhook/endpoint', { endpoint });
  if (s.status !== 200) throw new Error(`set webhook failed: ${s.status}`);
  const t = await call(token, f, 'POST', '/v2/bot/channel/webhook/test', { endpoint });
  if (t.status === 200 && t.json.success === true) return { endpoint, test: 'ok' };
  const code = typeof t.json.statusCode === 'number' ? t.json.statusCode : t.status;
  const reason = String(t.json.reason ?? '').replace(/[^A-Za-z0-9 _.-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { endpoint, test: `failed ${code} ${reason}`.trim() };
}

export async function lineStatusLines(db: Db, now: Date): Promise<string[]> {
  const month = lineMonth(now);
  const u = await readLineUsage(db, month);
  const n = await lineCounts(db);
  return [
    `month ${month} (Asia/Bangkok)`,
    `sent (ours) ${u.sent} · LINE totalUsage ${u.lineTotal ?? '-'}${u.checkedAt ? ` (checked ${u.checkedAt.toISOString()})` : ''} · limit ${lineLimit(u)} · reserve ${LINE.reserve} · used ${lineUsed(u)}`,
    `approved ${n.approved}/${LINE.maxApproved} · pending ${n.pending} · held this month ${u.held}${u.exhausted ? ' · EXHAUSTED (LINE answered 429)' : ''}`,
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  const read = fileSecrets(process.env);
  const token = read('LINE_CHANNEL_TOKEN');
  const status = async (): Promise<void> => {
    const conn = dbConn(process.env, read);
    if (!conn) throw new Error('no database config — run inside the api container');
    const pool = createPool(conn, { max: 1, applicationName: 'thuammai-line' });
    try {
      for (const l of await lineStatusLines(poolDb(pool), new Date())) console.log(l);
    } finally {
      await pool.end();
    }
  };
  const job = mode === 'check'
    ? lineCheck({ token }).then((id) => { console.log(`bot=${id}`); })
    : mode === 'set'
      ? lineSetWebhook({ token, origin: `https://${process.env.API_HOST ?? ''}` }).then((r) => { console.log(`webhook: ${r.endpoint}`); console.log(`webhook test: ${r.test}`); if (r.test !== 'ok') process.exitCode = 1; })
      : mode === 'status'
        ? status()
        : Promise.reject(new Error('usage: line.mjs check|set|status'));
  job.catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : 'failed');
    if (e instanceof LineRejected) console.log('rejected');
    process.exit(e instanceof LineRejected ? EXIT_REJECTED : 1);
  });
}
