import { logLine, type Counts } from '../../../src/alerts/log';

/** Request counters printed every 5 minutes, non-zero only (spec §7.4) — no paths, no IPs. */
export function newStats(log: (c: Counts) => void = (c) => logLine('api', 'stats', c)) {
  let c: Counts = {};
  const inc = (k: string) => { c[k] = (c[k] ?? 0) + 1; };
  return {
    count(req: Request, status: number): void {
      const p = new URL(req.url).pathname;
      if (p === '/v1/push/subscription' && req.method === 'POST') inc('push_post');
      else if (p === '/v1/push/subscription' && req.method === 'DELETE') inc('push_delete');
      else if (p === '/v1/telegram') inc('tg_updates');
      else if (p === '/v1/line') inc('line_updates');
      else if (p === '/v1/status') inc('status');
      inc(`s${Math.floor(status / 100)}xx`);
      if (status === 429) inc('s429');
    },
    flush(): void {
      const nz = Object.fromEntries(Object.entries(c).filter(([, v]) => v > 0));
      c = {};
      if (Object.keys(nz).length) log(nz);
    },
  };
}
