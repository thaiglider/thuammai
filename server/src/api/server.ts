import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'host']);

/** IncomingMessage → Web Request (R26): the body stays a stream, so readJson's byte counter
 *  stops reading at BODY_MAX. The host part of the URL is fixed; only the path matters. */
export function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i]!;
    if (!HOP.has(k.toLowerCase())) headers.append(k, req.rawHeaders[i + 1]!);
  }
  const method = req.method ?? 'GET';
  const path = req.url ?? '/';
  if (!path.startsWith('/')) throw new Error('bad request target');
  const withBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (withBody) { init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>; init.duplex = 'half'; }
  return new Request(`http://api.local${path}`, init);
}

async function write(res: ServerResponse, r: Response): Promise<void> {
  const body = Buffer.from(await r.arrayBuffer());
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(r.status, { ...h, 'content-length': String(body.byteLength) });
  res.end(body);
}

const BAD = () => new Response('{"error":"bad_request"}', { status: 400, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** Idle keep-alive (final review I2): longer than the reverse proxy's idle reuse of an upstream
 *  connection, so the proxy never sends a (non-idempotent) POST on a socket Node is just closing,
 *  which it would turn into a 502. Departs from spec §4.2 (5 s). headersTimeout/requestTimeout keep
 *  the spec's slow-client limits: on Node >= 18 they are measured per request, never over an idle
 *  keep-alive socket, so they need not exceed this (tests/server/api/server.test.ts). */
export const KEEP_ALIVE_MS = 65_000;

/** The api's HTTP server with the spec §4.2 limits. `handler` never sees raw sockets.
 *  `checkMs` (tests only) is how often Node checks those limits (default 30 s). */
export function apiServer(handler: (req: Request, peer: string, headers: IncomingHttpHeaders) => Promise<Response>, checkMs?: number): Server {
  const server = createServer(checkMs === undefined ? {} : { connectionsCheckingInterval: checkMs }, (req, res) => {
    void (async () => {
      let r: Response;
      try {
        r = await handler(toRequest(req), req.socket.remoteAddress ?? '', req.headers);
      } catch {
        r = BAD();
      }
      try { await write(res, r); } catch { res.destroy(); }
    })();
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.maxHeadersCount = 50;
  return server;
}
