import { runCron } from './cron';
import type { CacheLike, Env } from './env';
import { handle } from './router';

const edgeCache = (): CacheLike | null => (globalThis as unknown as { caches?: { default?: CacheLike } }).caches?.default ?? null;

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, { now: () => new Date(), fetch: (input, init) => fetch(input, init), cache: edgeCache() });
  },
  scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void {
    ctx.waitUntil(runCron(env.DB, new Date()));
  },
};
