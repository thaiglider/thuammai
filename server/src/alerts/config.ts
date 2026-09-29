import type { Counts } from '../../../src/alerts/log';
import type { AlertEnv } from '../../../src/alerts/main';
import { dbConn, withSlash, type ConfigResult } from '../api/config';
import type { PgConn } from '../db/pg';
import type { SecretReader } from '../secrets';

export interface AlertsConfig {
  siteUrl: string; env: AlertEnv; paused: boolean; kumaUrl: string | null; db: PgConn; tmpDir: string;
  /** CI stack test only (Plan F2): shifts the rule clock so the old fixture reads as fresh. Never set in production. */
  clockOffsetMs: number;
}

/** Checked at start (spec §4.3 step 1): database, VAPID and SITE_URL are required; Telegram and
 *  Kuma are optional. */
export function loadAlertsConfig(e: NodeJS.ProcessEnv, read: SecretReader): ConfigResult<AlertsConfig> {
  const db = dbConn(e, read);
  const priv = read('VAPID_PRIVATE_KEY');
  if (!db || !priv || !e.VAPID_PUBLIC_KEY || !e.VAPID_SUBJECT || !e.SITE_URL) return { ok: false, code: 'config_missing' };
  const clockOffsetMs = Number(e.THUAMMAI_CLOCK_OFFSET_MS ?? '0');
  if (!Number.isInteger(clockOffsetMs)) return { ok: false, code: 'config_invalid_clock' };
  const siteUrl = withSlash(e.SITE_URL);
  return {
    ok: true,
    cfg: {
      siteUrl,
      env: { VAPID_PUBLIC_KEY: e.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: e.VAPID_SUBJECT, TELEGRAM_BOT_TOKEN: read('TELEGRAM_BOT_TOKEN'), SITE_URL: siteUrl },
      paused: e.ALERTS_PAUSED === '1', kumaUrl: read('KUMA_PUSH_ALERTS') ?? null, db, tmpDir: e.TMPDIR || '/tmp', clockOffsetMs,
    },
  };
}

/** 0|1 flags for the `start` line (final review M5): a test knob left on, or a mistyped
 *  `*_FILE` path that silently turns Telegram or Kuma off, is visible — counts only. */
export const alertsStartFlags = (c: AlertsConfig): Counts => ({
  clock_offset: c.clockOffsetMs !== 0 ? 1 : 0,
  tg: c.env.TELEGRAM_BOT_TOKEN ? 1 : 0,
  kuma: c.kumaUrl ? 1 : 0,
});
