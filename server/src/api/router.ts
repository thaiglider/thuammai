import type { Deps, Env } from './env';
import { err, json, toResponse } from './http';
import { lineRoute } from './line';
import { pushRoute } from './push';
import { statusRoute } from './status';
import { telegramRoute } from './telegram';

/** The only public routes (spec §4.2); there is no internal API any more. */
export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname === '/v1/health' && req.method === 'GET') return json(200, { ok: true });
    if (url.pathname === '/v1/status') return await statusRoute(req, env, deps);
    if (url.pathname === '/v1/push/subscription') return await pushRoute(req, env, deps);
    if (url.pathname === '/v1/telegram') return await telegramRoute(req, env, deps);
    if (url.pathname === '/v1/line') return await lineRoute(req, env, deps);
    return err(404, 'not_found');
  } catch (e) {
    return toResponse(e);
  }
}
