/* ท่วมไหม service worker.
 * - install: precaches the app shell (page, entry JS/CSS, fonts, manifest, icon, provinces) so the
 *   app opens offline after a single online visit. BUILD and PRECACHE are filled in at build time
 *   by the `thuammai-sw` plugin in vite.config.ts (BUILD = hash of the shell files), so every
 *   release gets a new shell cache and `activate` deletes the old ones.
 * - data/ and p/ and navigations: network-first, cached under origin+pathname.
 * - everything else same-origin: stale-while-revalidate from the shell cache.
 * - data/meta.json with swKill: true unregisters this worker and clears every cache. */
const BUILD = 'dev'; // @build
const PRECACHE = []; // @precache
const SHELL = `shell-${BUILD}`;
const DATA = 'data-v1';

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
    for (const key of await caches.keys()) if (key !== SHELL && key !== DATA) await caches.delete(key);
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
