import type { Counts } from '../../../src/alerts/log';
import { ALERTS_ORIGIN_RE } from '../../../src/core/alert-config';
import type { PgConn } from '../db/pg';
import type { SecretReader } from '../secrets';
import type { IpMode } from './client-ip';

export interface ApiConfig {
  port: number; siteOrigins: readonly string[]; siteUrl: string; /** Links in bot messages (defaults to siteUrl). */ publicUrl: string; rateKey: string;
  tgToken?: string; tgSecret?: string; lineSecret?: string; lineToken?: string; relayKey?: string; relayToken?: string; lineOff: boolean; paused: boolean; ipMode: IpMode; trustedProxyHost: string; db: PgConn;
  /** CI only: the "broken image" of the update/rollback test exits at start (Plan F2). */
  ciBreak: boolean;
}
export type ConfigResult<T> = { ok: true; cfg: T } | { ok: false; code: string };

export const withSlash = (u: string): string => (u.endsWith('/') ? u : `${u}/`);

/** SITE_ORIGIN: comma-separated https origins (trimmed, no trailing slash, empties dropped). null when
 *  the list is empty or any value is not a plain https origin. */
export function parseOrigins(raw: string): string[] | null {
  const list = raw.split(',').map((x) => x.trim().replace(/\/+$/, '')).filter((x) => x !== '');
  return list.length > 0 && list.every((o) => ALERTS_ORIGIN_RE.test(o)) ? list : null;
}

/** PUBLIC_URL for links people see: unset or empty → the fallback; otherwise https, with a trailing slash; null when invalid. */
export function parsePublicUrl(raw: string | undefined, fallback: string): string | null {
  const v = (raw ?? '').trim();
  if (v === '') return fallback;
  return /^https:\/\/[^\s]+$/.test(v) ? withSlash(v) : null;
}

/** PG* variables with the password from PGPASSWORD_FILE. */
export function dbConn(e: NodeJS.ProcessEnv, read: SecretReader): PgConn | null {
  const password = read('PGPASSWORD');
  if (!password) return null;
  return { host: e.PGHOST || 'db', port: Number(e.PGPORT || 5432), database: e.PGDATABASE || 'thuammai', user: e.PGUSER || 'thuammai_app', password };
}

/** Checked at start (spec §4.2): database, rate key and site are required (exit 1 otherwise);
 *  Telegram is optional (its route answers 503 without it). */
export function loadApiConfig(e: NodeJS.ProcessEnv, read: SecretReader): ConfigResult<ApiConfig> {
  const mode = e.CLIENT_IP_MODE || 'direct';
  if (mode !== 'direct' && mode !== 'cloudflare') return { ok: false, code: 'config_invalid_ip_mode' };
  const db = dbConn(e, read);
  const rateKey = read('RATE_HMAC_KEY');
  if (!db || !rateKey || !e.SITE_ORIGIN || !e.SITE_URL) return { ok: false, code: 'config_missing' };
  const siteOrigins = parseOrigins(e.SITE_ORIGIN);
  const siteUrl = withSlash(e.SITE_URL);
  const publicUrl = parsePublicUrl(e.PUBLIC_URL, siteUrl);
  if (!siteOrigins || !publicUrl) return { ok: false, code: 'config_invalid' };
  return {
    ok: true,
    cfg: {
      port: Number(e.PORT || 8080), siteOrigins, siteUrl, publicUrl, rateKey,
      tgToken: read('TELEGRAM_BOT_TOKEN'), tgSecret: read('TELEGRAM_WEBHOOK_SECRET'),
      lineSecret: read('LINE_CHANNEL_SECRET'), lineToken: read('LINE_CHANNEL_TOKEN'), relayKey: read('RELAY_HMAC_KEY'), relayToken: read('RELAY_READ_TOKEN'), lineOff: e.LINE_OFF === '1',
      paused: e.ALERTS_PAUSED === '1', ipMode: mode, trustedProxyHost: e.TRUSTED_PROXY_HOST || 'caddy', db, ciBreak: e.CI_BREAK === '1',
    },
  };
}

/** 0|1 flags for the `start` line (final review M5): the CI-only knobs (THUAMMAI_CLOCK_OFFSET_MS is
 *  the alerts' knob, but both services share one .env) and whether Telegram is on (a mistyped
 *  `*_FILE` path silently turns it off). The api pushes nothing to Kuma, so it has no kuma flag. */
export const apiStartFlags = (c: ApiConfig, e: NodeJS.ProcessEnv): Counts => ({
  clock_offset: (e.THUAMMAI_CLOCK_OFFSET_MS ?? '').trim() !== '' && Number(e.THUAMMAI_CLOCK_OFFSET_MS) !== 0 ? 1 : 0,
  tg: c.tgToken && c.tgSecret ? 1 : 0,
  ci_break: c.ciBreak ? 1 : 0,
  line: c.lineSecret && c.lineToken ? 1 : 0,
});
