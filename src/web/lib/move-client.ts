import { alertsCfg, alertsMode, alertsOn, browserPushGlobals } from './alerts-state';
import type { Env } from './env';
import { clear, h } from './dom';
import { departPlan, moveLooping, moveUrl, MOVED_AT_KEY, MOVED_OLD_SUB_KEY, MOVED_ONCE_KEY, movedText, newHostReachable, readIncoming, readMoved, readOldSub, shouldMove, stripMoveParams, type OldSub } from './move';
import { decodePlacesFromHash, encodePlaces, mergePlaces, sanitizePlace, type Place } from './places';
import { loadSettings, saveSettings, type Settings } from './settings';
import { getJson, setJson, type KV } from './storage';

declare global { interface Window { __THUAMMAI_HOST__?: string } }

export const NEW_HOST_TH = 'flood.thaiglider.com';
const publicOrigin = (): string => import.meta.env.VITE_PUBLIC_ORIGIN ?? '';
/** The host under test may be faked only in the e2e build. */
const hostname = (): string => (import.meta.env.MODE === 'e2e' && window.__THUAMMAI_HOST__) || location.hostname;

function storedPlaces(kv: KV): Place[] {
  const s = getJson<unknown[]>(kv, 'places', []);
  return Array.isArray(s) ? s.map(sanitizePlace).filter((p): p is Place => p !== null) : [];
}

/** The old subscription's endpoint + auth, WITHOUT unsubscribing it (it stays until the new
 *  site's subscription is on). Any failure, or no answer in 2 s, is null. */
export async function readCurrentSub(): Promise<OldSub | null> {
  try {
    const get = (async () => {
      if (!('serviceWorker' in navigator)) return null;
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      const j = sub?.toJSON();
      return j?.endpoint && j.keys?.auth ? { endpoint: j.endpoint, auth: j.keys.auth } : null;
    })();
    return await Promise.race([get, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
  } catch { return null; }
}

/** "The site moved" + a link: when the redirect cannot happen, or the new site cannot be reached. */
export function moveBanner(href: string, why: 'blocked' | 'unreachable' = 'blocked'): HTMLElement {
  return h('div', { class: 'banner', 'data-testid': 'move-fallback' },
    h('span', {}, why === 'unreachable'
      ? `เว็บย้ายไป ${NEW_HOST_TH} แต่ตอนนี้เปิดเว็บใหม่ไม่ได้ — ใช้เว็บนี้ไปก่อน`
      : `เว็บย้ายไป ${NEW_HOST_TH}`),
    h('a', { class: 'primary', href }, 'ไปที่เว็บใหม่'));
}

const sessionGet = (k: string): string | null => { try { return sessionStorage.getItem(k); } catch { return null; } };
const sessionSet = (k: string, v: string): void => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } };

/** 'stay' = not the old host (or the move is off): render as usual. 'left' = a redirect was
 *  started: do not render. Otherwise render as usual AND show `fallback` (the move would loop, or
 *  the new host is not reachable right now — the old host keeps working). */
export type Depart = 'stay' | 'left' | { fallback: HTMLElement };

/** On the old host: send the visitor (places, settings, alerts subscription) to the new one. */
export async function departIfOldHost(kv: KV): Promise<Depart> {
  const pub = publicOrigin();
  if (!shouldMove(hostname(), pub)) return 'stay';
  const plan = departPlan({ saved: storedPlaces(kv), fromLink: decodePlacesFromHash(location.hash), movedOnce: kv.get(MOVED_ONCE_KEY) !== null });
  const raw = plan.sendSettings ? getJson<Partial<Settings> | null>(kv, 'settings', null) : null;
  const build = (old: OldSub | null) => moveUrl(pub, { search: location.search, places: plan.places, settings: raw && typeof raw === 'object' ? raw : null, old, incoming: plan.incoming });
  // The new host sent us back (e.g. its Caddy block was rolled back to the old 302): stay here.
  if (moveLooping({ movedAt: Number(sessionGet(MOVED_AT_KEY) ?? Number.NaN), now: Date.now(), referrer: document.referrer, publicOrigin: pub })) {
    return { fallback: moveBanner(build(null)) };
  }
  // The old subscription is read while the new host is checked (≤2 s and ≤3 s, side by side).
  const [old, up] = await Promise.all([readCurrentSub(), newHostReachable(pub, (i, o) => fetch(i, o))]);
  const url = build(old);
  if (!up) return { fallback: moveBanner(url, 'unreachable') };
  sessionSet(MOVED_AT_KEY, String(Date.now()));
  kv.set(MOVED_ONCE_KEY, new Date().toISOString());
  const app = document.getElementById('app');
  // If the navigation does not happen, say where the site went.
  window.setTimeout(() => { if (app) { clear(app); app.append(moveBanner(url)); } }, 3000);
  try { location.replace(url); } catch { if (app) { clear(app); app.append(moveBanner(url)); } }
  return 'left';
}

/** On arrival (?moved=1): a visitor with no saved places gets the carried ones straight away,
 *  with their settings; one who has places sees the usual import banner (the #p= hash stays).
 *  The old subscription is parked in storage until alerts are re-enabled here. Returns the
 *  info the banner needs, or null when this is not an arrival. */
export function arriveIfMoved(kv: KV): { old: OldSub | null; carried: boolean } | null {
  const m = readMoved(location.search, location.hash);
  if (!m.moved) return null;
  const carried = decodePlacesFromHash(location.hash);
  const incoming = readIncoming(location.hash);
  const fresh = kv.persistent && storedPlaces(kv).length === 0;
  if (fresh) {
    if (carried.length) setJson(kv, 'places', carried);
    if (m.settings) saveSettings(kv, { ...loadSettings(kv, false), ...m.settings });
  }
  // Kept in memory too when storage is unavailable, so the button still works this session.
  if (m.old) setJson(kv, MOVED_OLD_SUB_KEY, m.old);
  // What the import banner should offer: just the shared-link places once the carried ones are
  // saved; otherwise (they already had places here, or no storage) the carried ones as well.
  const offer = fresh ? incoming : mergePlaces(carried, incoming);
  const stripped = stripMoveParams(`${location.pathname}${location.search}${location.hash}`);
  const hi = stripped.indexOf('#');
  const base = hi < 0 ? stripped : stripped.slice(0, hi);
  const rest = hi < 0 ? '' : stripped.slice(hi + 1).split('&').filter((x) => !x.startsWith('p=')).join('&');
  const hash = [offer.length ? `p=${encodePlaces(offer)}` : '', rest].filter(Boolean).join('&');
  history.replaceState(null, '', `${base}${hash ? `#${hash}` : ''}`);
  return { old: readOldSub(kv) ?? m.old, carried: carried.length > 0 };
}

/** The alerts can be moved from the banner only where the regular alerts UI would offer Web Push
 *  (mode 'push'), and not when alerts are already on here (the next sync then drops the old one). */
export function offerMoveAlerts(kv: KV, env: Env, old: OldSub | null): boolean {
  return old !== null && !alertsOn(kv) && alertsMode(alertsCfg(), env, kv, browserPushGlobals(), storedPlaces(kv).length) === 'push';
}

export function movedBanner(kv: KV, env: Env, base: string, arrived: { old: OldSub | null; carried: boolean }): HTMLElement {
  const { old } = arrived;
  const bar = h('div', { class: 'banner', 'data-testid': 'moved-banner' });
  const text = h('span', {}, movedText(arrived.carried, NEW_HOST_TH));
  // Closing keeps the parked subscription: it is dropped when alerts are enabled here later.
  const close = h('button', { onclick: () => bar.remove() }, 'ปิด');
  bar.append(text);
  // Hidden or closed, the parked key stays: a later normal enable (or sync) still deletes it.
  if (old && offerMoveAlerts(kv, env, old)) {
    const msg = h('span', { role: 'status', 'data-testid': 'moved-alerts-msg' });
    // Loaded up front so the tap can ask for permission without waiting on a download.
    const mod = import('./alerts-client');
    void mod.catch(() => undefined);
    const btn = h('button', { class: 'primary', 'data-testid': 'moved-alerts', onclick: () => {
      btn.disabled = true;
      msg.textContent = '';
      void mod.then(async (c) => {
        const r = await c.enableAlerts(c.browserPushDeps(kv, base), storedPlaces(kv));
        if (r === 'ok') { btn.remove(); msg.textContent = 'ย้ายการแจ้งเตือนมาที่เว็บใหม่แล้ว'; return; }
        btn.disabled = false;
        msg.textContent = r === 'denied' ? 'ยังไม่ได้อนุญาตการแจ้งเตือน' : 'เปิดการแจ้งเตือนไม่สำเร็จ ลองใหม่อีกครั้ง';
      }).catch(() => { btn.disabled = false; msg.textContent = 'เปิดการแจ้งเตือนไม่สำเร็จ ลองใหม่อีกครั้ง'; });
    } }, 'ย้ายการแจ้งเตือนมาที่นี่');
    bar.append(btn, msg);
  }
  bar.append(close);
  return bar;
}
