import type { Db } from '../db/db';

export interface Env {
  db: Db;
  /** Origins allowed to call the browser routes (CORS): the request's own origin is echoed, never `*`. */
  SITE_ORIGINS: readonly string[];
  /** Where the data is fetched from. Always with a trailing slash. */
  SITE_URL: string;
  /** Links in bot messages, always with a trailing slash; absent → SITE_URL. */
  PUBLIC_URL?: string;
  /** HMAC key of every rate counter name (IPs, endpoints, chat ids and LINE user ids are never stored raw). */
  RATE_HMAC_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** LINE Messaging API channel (phase-3C spec §5.1): both or the route answers 503. */
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_TOKEN?: string;
  /** BMA relay (Plan M): both secrets or /v1/relay/bma answers 503 relay_off. */
  RELAY_HMAC_KEY?: string;
  RELAY_READ_TOKEN?: string;
  /** thuammai line off (G-5). */
  LINE_OFF?: boolean;
  /** Server-side emergency switch (R28). */
  ALERTS_PAUSED?: boolean;
}

/** Per request: the clock, outbound fetch, the client IP decided by client-ip.ts (F1-6), and — for the
 *  LINE fallback (spec §5.1 "กันหาย") — a timer that runs after the response (tests call it by hand). */
/** The origin of a request when it is one of the allowed site origins. */
export const allowedOrigin = (req: Request, env: Pick<Env, 'SITE_ORIGINS'>): string | null => {
  const o = req.headers.get('origin');
  return o !== null && env.SITE_ORIGINS.includes(o) ? o : null;
};
/** The site URL people are shown in messages. */
export const publicUrl = (env: Pick<Env, 'SITE_URL' | 'PUBLIC_URL'>): string => env.PUBLIC_URL || env.SITE_URL;

export interface Deps { now(): Date; fetch: typeof fetch; ip: string; later?(ms: number, fn: () => Promise<void>): void }
