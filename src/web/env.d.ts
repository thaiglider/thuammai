/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** The alerts server origin (the VPS, e.g. https://flood.thaiglider.com — public); empty/undefined = alerts off. */
  readonly VITE_ALERTS_ORIGIN?: string;
  /** VAPID public key, base64url (public). */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  /** Telegram bot username without @ (Plan E). */
  readonly VITE_TELEGRAM_BOT?: string;
}
