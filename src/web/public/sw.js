/* ท่วมไหม service worker.
 * - install: precaches the app shell (page, entry JS/CSS, fonts, manifest, icon, provinces) so the
 *   app opens offline after a single online visit. Lazy chunks (map, QR code) are not precached;
 *   they land in the shell cache by stale-while-revalidate the first time they are used. BUILD and
 *   PRECACHE are filled in at build time by vite.config.ts (BUILD = hash of the precached files),
 *   so every release gets a new shell cache and `activate` deletes the old ones.
 * - data/ and p/ and navigations: network-first, cached under origin+pathname.
 * - everything else same-origin: stale-while-revalidate from the shell cache.
 * - data/meta.json with swKill: true unregisters this worker and clears every cache.
 * - cross-origin requests are never intercepted: basemap style, sprites, glyphs and tiles from
 *   tiles.openfreemap.org (and Nominatim) go straight to the network with their own HTTP caching.
 *   We deliberately do not cache map tiles — the set is unbounded — so the map needs a connection;
 *   offline, the map tab shows the text list of flagged stations instead.
 * - push / notificationclick / pushsubscriptionchange: Web Push alerts (spec §6.3–6.4). The payload
 *   has no place name; the page keeps names in the alert-places-v1 cache for this worker. */
const BUILD = 'dev'; // @build
const PRECACHE = []; // @precache
const SHELL = `shell-${BUILD}`;
const DATA = 'data-v1';
const ALERTS_ORIGIN = ''; // @alerts
const ALERT_PLACES = 'alert-places-v1';
const KEEP = new Set([SHELL, DATA, ALERT_PLACES]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // One failed file must not stop the worker installing; runtime caching still fills gaps.
    await Promise.allSettled(PRECACHE.map(async (path) => {
      const url = new URL(path, self.location.href).href;
      const response = await fetch(url, { cache: 'no-cache' });
      if (response.ok) await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (!KEEP.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function killIfRequested(response) {
  try {
    const meta = await response.clone().json();
    if (meta && meta.swKill === true) {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
    }
  } catch { /* not JSON */ }
}

// Cached under origin+pathname (search stripped) so the `?v=<minute>` cache-buster on data/ and
// p/ requests — and any ?tab= variant on a navigation — doesn't fragment the cache into one
// entry per query string.
async function networkFirst(request, appPage) {
  const cache = await caches.open(DATA);
  const url = new URL(request.url);
  const key = new Request(url.origin + url.pathname);
  try {
    let response;
    let t;
    const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), 4000); });
    try {
      response = await Promise.race([fetch(request), timer]);
    } finally {
      clearTimeout(t);
    }
    if (response.ok) {
      cache.put(key, response.clone());
      if (url.pathname.endsWith('/data/meta.json')) await killIfRequested(response);
    }
    return response;
  } catch {
    const cached = await cache.match(key, { ignoreVary: true });
    if (cached) return cached;
    // The app page itself (./, ./index.html, any ?tab=): fall back to the precached shell.
    if (appPage) {
      const shell = await caches.open(SHELL);
      const opts = { ignoreVary: true };
      const page = (await shell.match(new URL('./', self.registration.scope).href, opts)) || (await shell.match(new URL('index.html', self.registration.scope).href, opts));
      if (page) return page;
    }
    throw new Error('offline and not cached');
  }
}

async function staleWhileRevalidate(event) {
  const request = event.request;
  const cache = await caches.open(SHELL);
  // ignoreVary: the precache fetch carries no Origin header, but module scripts are requested
  // with crossorigin (Origin set), so a `Vary: Origin` response would otherwise never match.
  const cached = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
  const network = fetch(request).then((response) => { if (response.ok) cache.put(request, response.clone()); return response; }).catch(() => cached);
  event.waitUntil(network);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  const path = url.pathname.slice(scope.length);
  if (request.mode === 'navigate' || path.startsWith('data/') || path.startsWith('p/')) {
    event.respondWith(networkFirst(request, request.mode === 'navigate' && (path === '' || path === 'index.html')));
  } else event.respondWith(staleWhileRevalidate(event));
});

async function alertNames() {
  try {
    const cache = await caches.open(ALERT_PLACES);
    const res = await cache.match(new URL('./__alert-places.json', self.registration.scope).href);
    if (!res) return null;
    const j = await res.json();
    return j && j.v === 1 && j.names && typeof j.names === 'object' ? j.names : null;
  } catch {
    return null;
  }
}

function placeLabel(names, key) {
  const list = names && Array.isArray(names[key]) ? names[key].filter((n) => typeof n === 'string' && n) : [];
  if (list.length === 0) return 'จุดที่คุณติดตาม';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]}, ${list[1]}`;
  return `${list[0]} และอีก ${list.length - 1} จุด`;
}

// userVisibleOnly: every push must show a notification, even one we cannot read.
async function showAlert(data) {
  let p = null;
  try { p = data ? data.json() : null; } catch { /* not JSON */ }
  const ok = p && p.v === 1 && (p.t === 'alert' || p.t === 'clear' || p.t === 'trend') && typeof p.k === 'string' && typeof p.title === 'string' && typeof p.body === 'string';
  if (!ok) {
    return self.registration.showNotification('ท่วมไหม', { body: 'มีการเปลี่ยนแปลงที่จุดที่คุณติดตาม — แตะเพื่อดู', icon: './icon-192.png', data: { url: './' } });
  }
  // A trend note travels as t:'alert' + x:'trend' (so workers installed before it existed still show it).
  const trend = p.t === 'trend' || p.x === 'trend';
  const name = placeLabel(await alertNames(), p.k);
  return self.registration.showNotification(`${name}: ${p.title}`, {
    body: p.body, tag: trend ? `${p.k}:trend` : p.k, renotify: p.t !== 'clear', requireInteraction: p.l === 4 && !trend, // a trend is not an alarm: never pin it (p.l is the shown level)
    icon: './icon-192.png', data: { url: './' },
  });
}

self.addEventListener('push', (event) => event.waitUntil(showAlert(event.data)));

// Open the app itself (not ?lat=&lon=, which would offer to add the place again).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).find((c) => c.url.startsWith(scope));
    if (open) return open.focus();
    return self.clients.openWindow('./');
  })());
});

// The push service rotated the subscription: re-register it with the saved keys (points only).
// Without saved keys, the page fixes it on the next visit.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const sub = event.newSubscription;
    if (!ALERTS_ORIGIN || !sub) return;
    const names = await alertNames();
    const places = Object.keys(names || {})
      .map((k) => k.split(',').map(Number))
      .filter((a) => a.length === 2 && a.every(Number.isFinite))
      .slice(0, 10)
      .map(([lat, lon]) => ({ lat, lon }));
    if (!places.length) return;
    const j = sub.toJSON();
    try {
      await fetch(`${ALERTS_ORIGIN}/v1/push/subscription`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, places }) });
    } catch { /* offline: the page re-syncs on the next visit */ }
  })());
});
