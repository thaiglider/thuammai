import type { Db } from '../db/db';

export interface Env {
  db: Db;
  SITE_ORIGIN: string;
  /** Always with a trailing slash. */
  SITE_URL: string;
  /** HMAC key of every rate counter name (IPs, endpoints and chat ids are never stored raw). */
  RATE_HMAC_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Server-side emergency switch (R28). */
  ALERTS_PAUSED?: boolean;
}

/** Per request: the clock, outbound fetch, and the client IP decided by client-ip.ts (F1-6). */
export interface Deps { now(): Date; fetch: typeof fetch; ip: string }
