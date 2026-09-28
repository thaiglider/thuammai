import './styles.css';
import { clear, h } from './lib/dom';
import { browserEnvGlobals, detectEnv } from './lib/env';
import { DataStore, fetchLoader, SchemaMismatchError, type Meta } from './lib/data';
import { effectiveNow, freshness } from './lib/freshness';
import { applySettings, loadSettings } from './lib/settings';
import { browserStorage } from './lib/storage';
import { loadErrorBanner, renderHome, renderPlacesWithoutData, warmCache, type AppCtx } from './views/home';
import { renderMapTab } from './views/map';
import { renderPage } from './views/pages';
import { renderShell, type Tab } from './views/shell';

const TAB_SET: readonly Tab[] = ['home', 'map', 'areas', 'help', 'sources', 'about'];
export function currentTab(): Tab {
  const t = new URLSearchParams(location.search).get('tab') as Tab | null;
  return t && TAB_SET.includes(t) ? t : 'home';
}

declare global { interface Window { __THUAMMAI_NOW__?: string } }

async function boot(): Promise<void> {
  const kv = browserStorage();
  const env = detectEnv(browserEnvGlobals());
  const settings = loadSettings(kv, env.saveData);
  applySettings(document, settings);
  const tab = currentTab();
  const shell = renderShell(document.getElementById('app')!, tab);
  const base = new URL('./', location.href).href;
  const store = new DataStore(fetchLoader(base));
  if (env.isLine) {
    shell.banners.append(h('div', { class: 'banner', 'data-testid': 'line-banner' },
      h('span', {}, 'เปิดใน Chrome/Safari เพื่อบันทึกจุดและเปิดออฟไลน์ได้'),
      h('button', { onclick: (e: Event) => (e.currentTarget as HTMLElement).parentElement?.remove() }, 'ปิด')));
  }
  let meta: Meta | null = null;
  let serverDate: string | null = null;
  let renderGen = 0;
  let swRegisterAttempted = false;
  // Registration must wait until meta is known so a kill switch published server-side can be
  // honoured before we ever install a (possibly stale/broken) worker; once registered we never
  // register again this page load — a redundant register() call is harmless but pointless.
  const manageServiceWorker = (m: Meta) => {
    if (!env.canServiceWorker) return;
    if (m.swKill === true) {
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister())).catch(() => undefined);
      return;
    }
    if (swRegisterAttempted) return;
    swRegisterAttempted = true;
    // The first page load happened before any worker existed, so none of its data/ responses are
    // cached. When the worker takes control, drop the in-memory copies and fetch the same files
    // again (data only, the DOM is left alone so nothing the user is typing is lost) so they go
    // through the worker and land in its cache — that is what makes the app open offline after a
    // single online visit.
    navigator.serviceWorker.addEventListener('controllerchange', () => { store.reset(); void warmCache(store, kv, deviceNow()); });
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => undefined);
  };
  const deviceNow = () => (window.__THUAMMAI_NOW__ ? new Date(window.__THUAMMAI_NOW__) : new Date());
  const render = async () => {
    // A generation token serializes overlapping renders (periodic tick, visibility/online
    // events, and a "ลองใหม่" retry can all call render() close together) so a slower, stale
    // call never clobbers a faster, newer one.
    const gen = ++renderGen;
    try {
      ({ meta, serverDate } = await store.meta());
      manageServiceWorker(meta);
    } catch (e) {
      if (gen !== renderGen) return;
      if (e instanceof SchemaMismatchError) {
        if (!shell.banners.querySelector('[data-testid="schema-banner"]')) {
          shell.banners.append(h('div', { class: 'banner', 'data-testid': 'schema-banner' },
            h('span', {}, 'มีเวอร์ชันใหม่ของเว็บ'),
            h('button', { class: 'primary', onclick: () => location.reload() }, 'แตะเพื่อโหลดใหม่')));
        }
        return;
      }
      if (!meta) {
        shell.freshness.textContent = 'โหลดข้อมูลไม่ได้ — ตรวจสอบอินเทอร์เน็ต';
        shell.freshness.className = 'fresh offline';
        clear(shell.main);
        shell.main.append(
          h('p', { role: 'alert' }, 'โหลดข้อมูลไม่ได้ — ตรวจสอบอินเทอร์เน็ต'),
          h('button', { class: 'primary', 'data-testid': 'retry', onclick: () => void render() }, 'ลองใหม่'));
        if (tab === 'home') renderPlacesWithoutData(shell.main, kv);
        return;
      }
      // meta was already loaded once before; keep showing the last snapshot and just let the
      // freshness display below reflect the passing time.
    }
    if (gen !== renderGen) return;
    const now = effectiveNow(deviceNow(), serverDate, meta!.generatedAt);
    const fr = freshness(meta!.generatedAt, now, navigator.onLine);
    shell.freshness.textContent = fr.text;
    shell.freshness.className = `fresh ${fr.state}`;
    const ctx: AppCtx = { shell, store, kv, env, settings, meta: meta!, serverDate, now: () => effectiveNow(deviceNow(), serverDate, meta!.generatedAt), online: () => navigator.onLine, base };
    try {
      if (tab === 'home') await renderHome(ctx);
      else if (tab === 'map') await renderMapTab(ctx);
      else await renderPage(tab, ctx);
    } catch {
      // Any other failed fetch while drawing: say so and offer a retry rather than leave a blank
      // or half-drawn page. The periodic/online refresh below keeps retrying on its own too.
      if (gen !== renderGen) return;
      shell.main.querySelector('[data-testid="load-error"]')?.remove();
      shell.main.prepend(loadErrorBanner(() => void render()));
    }
  };
  // Refresh wiring goes in before the first render, so a failing first render can never stop it.
  let timer = window.setInterval(() => { if (!document.hidden) void render(); }, 5 * 60e3);
  document.addEventListener('visibilitychange', () => {
    clearInterval(timer);
    if (!document.hidden) { void render(); timer = window.setInterval(() => void render(), 5 * 60e3); }
  });
  window.addEventListener('online', () => void render());
  window.addEventListener('offline', () => void render());
  await render();
}

void boot();
