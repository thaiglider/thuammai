import { VEHICLES } from '../../core/thresholds';
import { decodePlacesFromHash, encodePlaces, placeKey, type Place } from './places';
import type { Settings } from './settings';
import { getJson, type KV } from './storage';

/* Moving visitors of the old GitHub Pages host to the new domain. Everything that crosses the
 * origin boundary travels in the URL hash (never sent to a server): the places (#p=), a few
 * settings (&s=) and the old push subscription's endpoint+auth (&old=), so the new site can drop
 * the old subscription only after the user has re-subscribed there. */

export const OLD_HOST = 'thaiglider.github.io';
export interface OldSub { endpoint: string; auth: string }

export function shouldMove(hostname: string, publicOrigin: string): boolean {
  return hostname === OLD_HOST && publicOrigin !== '';
}

/** localStorage key (thuammai.movedOldSub) holding the old push subscription until the new one is on. */
export const MOVED_OLD_SUB_KEY = 'movedOldSub';
export const readOldSub = (kv: KV): OldSub | null => pickOld(getJson<unknown>(kv, MOVED_OLD_SUB_KEY, null));

/** localStorage key (thuammai.movedOnce): this browser was already sent over once from the old
 *  host, so later visits there carry only what is new (a shared link's places, the old subscription). */
export const MOVED_ONCE_KEY = 'movedOnce';
/** sessionStorage key: when this tab last left the old host for the new one (redirect-loop guard). */
export const MOVED_AT_KEY = 'thuammai.movedAt';
export const LOOP_WINDOW_MS = 60_000;
export const PROBE_TIMEOUT_MS = 3_000;

/** What travels on a move. Saved places (p=) and settings (s=) only the first time; places from a
 *  shared link in the URL always travel as i= (offered with the import banner, never auto-saved),
 *  minus those already saved. */
export function departPlan(o: { saved: Place[]; fromLink: Place[]; movedOnce: boolean }): { places: Place[]; incoming: Place[]; sendSettings: boolean } {
  const known = new Set(o.saved.map(placeKey));
  return {
    places: o.movedOnce ? [] : o.saved,
    incoming: o.fromLink.filter((p) => !known.has(placeKey(p))),
    sendSettings: !o.movedOnce,
  };
}

/** true = do NOT redirect: this tab left for the new host less than a minute ago, or the new host
 *  sent us back here (e.g. its Caddy block was rolled back to the old 302) — going again would loop. */
export function moveLooping(o: { movedAt: number | null; now: number; referrer: string; publicOrigin: string }): boolean {
  if (o.movedAt !== null && Number.isFinite(o.movedAt) && o.now - o.movedAt >= 0 && o.now - o.movedAt < LOOP_WINDOW_MS) return true;
  return o.publicOrigin !== '' && (o.referrer === o.publicOrigin || o.referrer.startsWith(`${o.publicOrigin}/`));
}

/** true when the new host answers with the web right now (a 2xx for its manifest within 3 s).
 *  A CORS request (Pages sends Access-Control-Allow-Origin: *), so a Cloudflare 52x page for a
 *  VPS that is down, or the old Caddy block's 404, counts as unreachable — an opaque no-cors
 *  answer could not tell those apart from the real site. */
export async function newHostReachable(publicOrigin: string, f: typeof fetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await f(`${publicOrigin}/manifest.webmanifest`, { mode: 'cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
    return r.ok;
  } catch { return false; } finally { clearTimeout(t); }
}

export const movedText = (carried: boolean, host: string): string => `ท่วมไหมย้ายมาที่ ${host} แล้ว${carried ? ' — จุดของคุณย้ายมาด้วย' : ''}`;

const PASS_QUERY = ['tab', 'lat', 'lon', 'z', 'exit'] as const;

const toB64 = (o: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
function fromB64(s: string): unknown {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch { return null; }
}

/** Only size/theme/vehicle/saveData survive, each validated; null when nothing valid is left. */
const pickSettings = (x: unknown): Partial<Settings> | null => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (o.size === 'a' || o.size === 'a2' || o.size === 'a3') out.size = o.size;
  if (o.theme === 'auto' || o.theme === 'light' || o.theme === 'dark') out.theme = o.theme;
  if (o.vehicle === 'none' || (VEHICLES as readonly unknown[]).includes(o.vehicle)) out.vehicle = o.vehicle as Settings['vehicle'];
  if (typeof o.saveData === 'boolean') out.saveData = o.saveData;
  return Object.keys(out).length ? out : null;
};

const pickOld = (x: unknown): OldSub | null => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.endpoint !== 'string' || typeof o.auth !== 'string') return null;
  if (o.endpoint.length > 1000 || !/^[A-Za-z0-9_-]{1,64}$/.test(o.auth)) return null;
  try { if (new URL(o.endpoint).protocol !== 'https:') return null; } catch { return null; }
  return { endpoint: o.endpoint, auth: o.auth };
};

const MAX_URL = 7500;

/** The URL, with the shared-link places (least important) trimmed from the end if it would grow past MAX_URL. */
export function moveUrl(publicOrigin: string, o: { search: string; places: Place[]; settings: Partial<Settings> | null; old: OldSub | null; incoming?: Place[] }): string {
  let incoming = o.incoming ?? [];
  for (;;) {
    const url = buildUrl(publicOrigin, o, incoming);
    if (url.length <= MAX_URL || incoming.length === 0) return url;
    incoming = incoming.slice(0, -1);
  }
}

function buildUrl(publicOrigin: string, o: { search: string; places: Place[]; settings: Partial<Settings> | null; old: OldSub | null }, incoming: Place[]): string {
  const src = new URLSearchParams(o.search);
  const q = new URLSearchParams({ moved: '1' });
  for (const k of PASS_QUERY) { const v = src.get(k); if (v !== null) q.set(k, v); }
  const parts: string[] = [];
  if (o.places.length) parts.push(`p=${encodePlaces(o.places)}`);
  // Places from a shared link the visitor opened on the old host: kept apart from their own (p=).
  if (incoming.length) parts.push(`i=${encodePlaces(incoming)}`);
  const s = pickSettings(o.settings);
  if (s) parts.push(`s=${toB64(s)}`);
  if (o.old) parts.push(`old=${toB64({ endpoint: o.old.endpoint, auth: o.old.auth })}`);
  return `${publicOrigin}/?${q.toString()}${parts.length ? `#${parts.join('&')}` : ''}`;
}

const hashKey = (hash: string, key: string): string | null => new RegExp(`(?:^#|&)${key}=([^&]*)`).exec(hash)?.[1] ?? null;

export function readMoved(search: string, hash: string): { moved: boolean; settings: Partial<Settings> | null; old: OldSub | null } {
  if (new URLSearchParams(search).get('moved') !== '1') return { moved: false, settings: null, old: null };
  const s = hashKey(hash, 's');
  const o = hashKey(hash, 'old');
  return { moved: true, settings: s === null ? null : pickSettings(fromB64(s)), old: o === null ? null : pickOld(fromB64(o)) };
}

/** The places of a shared link carried across the move (`i=`), same format as `p=`. */
export const readIncoming = (hash: string): Place[] => {
  const v = hashKey(hash, 'i');
  return v === null ? [] : decodePlacesFromHash(`#p=${v}`);
};

/** Removes `moved` from the query and `s`/`old`/`i` from the hash (keeps `p=`). */
export function stripMoveParams(url: string): string {
  const hi = url.indexOf('#');
  const hash = hi < 0 ? '' : url.slice(hi + 1);
  const rest = hi < 0 ? url : url.slice(0, hi);
  const qi = rest.indexOf('?');
  const path = qi < 0 ? rest : rest.slice(0, qi);
  const q = new URLSearchParams(qi < 0 ? '' : rest.slice(qi + 1));
  q.delete('moved');
  const qs = q.toString();
  const hs = hash.split('&').filter((x) => x !== '' && !/^(?:s|old|i)=/.test(x)).join('&');
  return `${path}${qs ? `?${qs}` : ''}${hs ? `#${hs}` : ''}`;
}
