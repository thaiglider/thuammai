import { ALERTS_ORIGIN_RE } from '../core/alert-config';

/** The origin the site build uses (I2, overrides plan ruling 15): an invalid VITE_ALERTS_ORIGIN
 *  must not stop the site deploy (the flood data would freeze for everyone), so the build goes on
 *  with alerts off (CSP and sw.js unchanged) and a warning. The alerts job validates ALERTS_ORIGIN
 *  itself and fails there. */
export function alertsOriginForBuild(raw: string | undefined): { origin: string; warning: string | null } {
  if (!raw) return { origin: '', warning: null };
  if (ALERTS_ORIGIN_RE.test(raw)) return { origin: raw, warning: null };
  return { origin: '', warning: 'VITE_ALERTS_ORIGIN is not an https:// origin with no path (e.g. https://flood.thaiglider.com) — building with alerts OFF' };
}

/** index.html with the alerts server origin appended to connect-src (spec §6.6); byte-for-byte
 *  unchanged when alerts are off. Callers pass an origin from alertsOriginForBuild; anything else
 *  invalid still throws (never widen the CSP with a bad value). */
export function cspWithAlerts(html: string, origin: string | undefined): string {
  if (!origin) return html;
  if (!ALERTS_ORIGIN_RE.test(origin)) throw new Error('VITE_ALERTS_ORIGIN must be an https:// origin with no path, e.g. https://flood.thaiglider.com');
  const out = html.replace(/(connect-src [^;"]*)/, `$1 ${origin}`);
  if (out === html) throw new Error('connect-src not found in the index.html CSP');
  return out;
}

/** index.html for the build: the alerts origin (spec §6.6) and the public origin (Plan I — on the
 *  old host the page checks the new one is up before moving) appended to connect-src, each once;
 *  byte-for-byte unchanged when both are empty. */
export function cspForBuild(html: string, alertsOrigin: string, publicOrigin: string): string {
  const pub = publicOriginForBuild(publicOrigin);
  const withAlerts = cspWithAlerts(html, alertsOrigin || undefined);
  if (!pub || pub === alertsOrigin) return withAlerts;
  const out = withAlerts.replace(/(connect-src [^;"]*)/, `$1 ${pub}`);
  if (out === withAlerts) throw new Error('connect-src not found in the index.html CSP');
  return out;
}

/** sw.js with the alerts server origin filled in (used by pushsubscriptionchange); "" when alerts are off. */
export function swWithAlerts(sw: string, origin: string | undefined): string {
  const placeholder = /^const ALERTS_ORIGIN = .*; \/\/ @alerts$/m;
  if (!placeholder.test(sw)) throw new Error('sw.js @alerts placeholder not found');
  return sw.replace(placeholder, `const ALERTS_ORIGIN = ${JSON.stringify(origin ?? '')};`);
}

/** VITE_PUBLIC_ORIGIN (Plan I): empty = no move; otherwise an https:// origin with no path, or the
 *  build fails — a wrong value would send every visitor of the old host to a broken address. */
export function publicOriginForBuild(raw: string | undefined): string {
  if (!raw) return '';
  if (!ALERTS_ORIGIN_RE.test(raw)) throw new Error('VITE_PUBLIC_ORIGIN must be an https:// origin with no path, e.g. https://flood.thaiglider.com (or empty to switch the move off)');
  return raw;
}
