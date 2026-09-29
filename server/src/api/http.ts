import { createHash, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly headers: Record<string, string> = {}) {
    super(code);
    this.name = 'HttpError';
  }
}

const BASE = { 'cache-control': 'no-store' };

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE, 'content-type': 'application/json; charset=utf-8', ...headers } });
}
/** Error bodies are a short English code only — never an echo of anything the client sent. */
export const err = (status: number, code: string, headers: Record<string, string> = {}): Response => json(status, { error: code }, headers);
export const empty = (status: number, headers: Record<string, string> = {}): Response => new Response(null, { status, headers: { ...BASE, ...headers } });

export function withHeaders(r: Response, headers: Record<string, string>): Response {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
}

/** HttpError → its own status; anything else (database errors, bugs) → 503 unavailable. */
export function toResponse(e: unknown): Response {
  if (e instanceof HttpError) return err(e.status, e.code, e.headers);
  return err(503, 'unavailable');
}

/** The raw body through a byte-counting reader (Content-Length is not trusted alone): 413 over `max`. */
export async function readBody(req: Request, max: number): Promise<Uint8Array> {
  const len = req.headers.get('content-length');
  if (len !== null && Number(len) > max) throw new HttpError(413, 'too_large');
  if (!req.body) throw new HttpError(400, 'bad_json');
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new HttpError(413, 'too_large');
    }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  return buf;
}

/** A JSON body read through readBody. */
export async function readJson(req: Request, max: number): Promise<unknown> {
  const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
  const buf = await readBody(req, max);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new HttpError(400, 'bad_json'); }
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'bad_json'); }
}

/** Constant-time comparison of two secrets of any length: both are hashed first (spec §6.1). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** The UTC calendar day "YYYY-MM-DD" (daily counters stay UTC days — R20, the web's nextUtcDay). */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
