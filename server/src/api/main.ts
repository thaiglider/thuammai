import type { IncomingHttpHeaders, Server } from 'node:http';
import { logLine } from '../../../src/alerts/log';
import { createPool, poolDb } from '../db/pg';
import { fileSecrets } from '../secrets';
import { clientIp, trustedResolver } from './client-ip';
import { apiStartFlags, loadApiConfig } from './config';
import type { Env } from './env';
import { handle } from './router';
import { apiServer } from './server';
import { newStats } from './stats';

const one = (h: IncomingHttpHeaders[string]): string | null => (Array.isArray(h) ? h.join(',') : h ?? null);

/** The api process (spec §4.2): config checked first (exit 1 when incomplete), pool of 5 as
 *  thuammai_app, listens on :8080 (never published — caddy reaches it on ai-stack). */
export async function startApi(e: NodeJS.ProcessEnv): Promise<Server | null> {
  const c = loadApiConfig(e, fileSecrets(e));
  if (!c.ok) { logLine('api', 'error', { [c.code]: 1 }); return null; }
  if (c.cfg.ciBreak) { logLine('api', 'error', { ci_break: 1 }); return null; }
  const pool = createPool(c.cfg.db, { max: 5, applicationName: 'thuammai-api' });
  const env: Env = {
    db: poolDb(pool), SITE_ORIGINS: c.cfg.siteOrigins, SITE_URL: c.cfg.siteUrl, PUBLIC_URL: c.cfg.publicUrl, RATE_HMAC_KEY: c.cfg.rateKey,
    TELEGRAM_BOT_TOKEN: c.cfg.tgToken, TELEGRAM_WEBHOOK_SECRET: c.cfg.tgSecret,
    LINE_CHANNEL_SECRET: c.cfg.lineSecret, LINE_CHANNEL_TOKEN: c.cfg.lineToken, LINE_OFF: c.cfg.lineOff, RELAY_HMAC_KEY: c.cfg.relayKey, RELAY_READ_TOKEN: c.cfg.relayToken,
    ALERTS_PAUSED: c.cfg.paused,
  };
  const trust = trustedResolver(c.cfg.trustedProxyHost);
  await trust.refresh();
  const stopTrust = trust.start();
  const stats = newStats();
  const server = apiServer(async (req, peer, h) => {
    const xff = one(h['x-forwarded-for']);
    void trust.seen(peer, xff);
    const ip = clientIp(peer, xff, one(h['cf-connecting-ip']), { mode: c.cfg.ipMode, trusted: trust.current() });
    const r = await handle(req, env, { now: () => new Date(), fetch: (i, init) => fetch(i, init), ip });
    stats.count(req, r.status);
    return r;
  });
  const statsTimer = setInterval(() => stats.flush(), 5 * 60_000);
  statsTimer.unref();
  await new Promise<void>((res) => server.listen(c.cfg.port, '0.0.0.0', res));
  logLine('api', 'start', { port: c.cfg.port, paused: c.cfg.paused ? 1 : 0, ...apiStartFlags(c.cfg, e) });
  const stop = () => {
    stopTrust();
    clearInterval(statsTimer);
    stats.flush();
    logLine('api', 'stop', {});
    server.close(() => { void pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}
