import type { Db } from '../db/db';

export interface Env {
  db: Db;
  SITE_ORIGIN: string;
  /** Always with a trailing slash. */
  SITE_URL: string;
  /** HMAC key of every rate counter name (IPs, endpoints, chat ids and LINE user ids are never stored raw). */
  RATE_HMAC_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** LINE Messaging API channel (phase-3C spec §5.1): both or the route answers 503. */
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_TOKEN?: string;
  /** thuammai line off (G-5). */
  LINE_OFF?: boolean;
  /** Server-side emergency switch (R28). */
  ALERTS_PAUSED?: boolean;
}

/** Per request: the clock, outbound fetch, the client IP decided by client-ip.ts (F1-6), and — for the
 *  LINE fallback (spec §5.1 "กันหาย") — a timer that runs after the response (tests call it by hand). */
export interface Deps { now(): Date; fetch: typeof fetch; ip: string; later?(ms: number, fn: () => Promise<void>): void }
