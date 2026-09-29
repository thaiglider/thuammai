import webpush from 'web-push';
import { logLine } from '../../../src/alerts/log';
import type { AlertDeps } from '../../../src/alerts/main';
import { loadProvinces } from '../../../src/alerts/snapshot';
import { alertsStartFlags, loadAlertsConfig } from '../alerts/config';
import { kumaPush } from '../alerts/kuma';
import { pgLineRepo } from '../alerts/line-repo-pg';
import { pgAdvisoryLock } from '../alerts/lock';
import { startAlerts } from '../alerts/main';
import { pgRepo } from '../alerts/repo-pg';
import { heartbeat } from '../alerts/run-state';
import { pgWakeClient, wakeListener } from '../alerts/wake';
import { createPool, poolDb } from '../db/pg';
import { installCrashHandler, onceExit } from '../crash';
import { fileSecrets } from '../secrets';

// Last resort (restored from the phase-2 CLI): one counts-only line, exit 1 — never a message or stack.
installCrashHandler('alerts');

const c = loadAlertsConfig(process.env, fileSecrets(process.env));
if (!c.ok) {
  logLine('alerts', 'error', { [c.code]: 1 });
  process.exit(1);
}
const cfg = c.cfg;
const pool = createPool(cfg.db, { max: 4, applicationName: 'thuammai-alerts' });
const db = poolDb(pool);
const HEARTBEAT_QUERY_MS = 10_000;
const bounded = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let h: NodeJS.Timeout | undefined;
  const cut = new Promise<never>((_r, rej) => { h = setTimeout(() => rej(new Error('timeout')), ms); });
  return Promise.race([p, cut]).finally(() => clearTimeout(h));
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alert: AlertDeps = {
  repo: pgRepo(db), env: cfg.env,
  now: () => new Date(Date.now() + cfg.clockOffsetMs),
  fetch: (i, init) => fetch(i, init),
  sendNotification: (sub, payload, opts) => webpush.sendNotification(sub, payload, opts),
  sleep,
  lineRepo: pgLineRepo(db),
};
const log = (event: Parameters<typeof logLine>[1], counts: Record<string, number>) => logLine('alerts', event, counts);
const handle = startAlerts({
  loop: { alert, db, siteUrl: cfg.siteUrl, provinces: loadProvinces(), tmpDir: cfg.tmpDir, paused: cfg.paused, log },
  lock: pgAdvisoryLock(cfg.db),
  // Bounded: one beat at a time, so a hanging query must not silence the heartbeat for good.
  heartbeat: (at) => bounded(heartbeat(db, at), HEARTBEAT_QUERY_MS),
  // Not configured: nothing to push, nothing failed.
  kuma: async (status, msg) => (cfg.kumaUrl ? kumaPush(cfg.kumaUrl, status, msg, fetch) : true),
  // The first exit code wins (a watchdog or lost-lock exit 1 stays 1 through a later SIGTERM).
  exit: onceExit(() => pool.end()),
  clock: Date.now,
  sleep,
  log,
  startFlags: alertsStartFlags(cfg),
});
// NOTIFY thuammai_wake (a LINE location was queued) → tick soon (phase-3C spec §5.2).
const wake = wakeListener({ client: pgWakeClient(cfg.db), onWake: () => handle.wake(), sleep, log: (c) => log('error', c) });
const stop = () => { void wake.stop(); void handle.stop(); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
