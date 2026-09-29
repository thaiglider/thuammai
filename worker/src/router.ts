import type { Deps, Env } from './env';
import { internalRoute } from './internal';
import { err, json, toResponse } from './http';
import { pushRoute } from './push';

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname === '/v1/health' && req.method === 'GET') return json(200, { ok: true });
    if (url.pathname === '/v1/push/subscription') return await pushRoute(req, env, deps);
    if (url.pathname.startsWith('/internal/v1/')) return await internalRoute(req, env, deps, url);
    // (routes added by later tasks go here)
    return err(404, 'not_found');
  } catch (e) {
    return toResponse(e);
  }
}
