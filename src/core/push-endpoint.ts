import { PUSH_HOST_SUFFIX, PUSH_HOSTS } from './alert-config';

/** Only real push services may ever receive a request from us (checked by the Worker on
 *  subscribe and again by the alerts job before every send). */
export function isAllowedPushEndpoint(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 1024) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname;
  return (PUSH_HOSTS as readonly string[]).includes(host)
    || (host.endsWith(PUSH_HOST_SUFFIX) && host.length > PUSH_HOST_SUFFIX.length);
}
