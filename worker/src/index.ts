import { runCron } from './cron';
import type { Env } from './env';
import { handle } from './router';

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, { now: () => new Date(), fetch: (input, init) => fetch(input, init) });
  },
  scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void {
    ctx.waitUntil(runCron(env.DB, new Date()));
  },
};
