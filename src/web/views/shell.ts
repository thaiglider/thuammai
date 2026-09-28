import { EMERGENCY } from '../../core/labels';
import { h } from '../lib/dom';
import { trapFocus } from '../lib/focus';

export type Tab = 'home' | 'map' | 'areas' | 'help' | 'sources' | 'about';
export interface ShellRefs { main: HTMLElement; freshness: HTMLElement; banners: HTMLElement; nav: HTMLElement; brand: HTMLAnchorElement }

const TABS: { tab: Tab; ico: string; label: string }[] = [
  { tab: 'home', ico: '🏠', label: 'จุดของฉัน' },
  { tab: 'map', ico: '🗺️', label: 'แผนที่' },
  { tab: 'areas', ico: '📋', label: 'รายพื้นที่' },
  { tab: 'help', ico: '🆘', label: 'ช่วยเหลือ' },
  { tab: 'about', ico: '☰', label: 'เมนู' },
];
/** Pages reached from เมนู keep เมนู highlighted. */
const navTab = (t: Tab): Tab => (t === 'sources' ? 'about' : t);

export function tabHref(tab: Tab): string {
  return tab === 'home' ? `./${location.hash}` : `./?tab=${tab}${location.hash}`;
}

export function openEmergency(): void {
  const opener = document.activeElement as HTMLElement | null;
  const close = () => {
    sheet.remove();
    document.removeEventListener('keydown', onKeydown);
    opener?.focus();
  };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'โทรฉุกเฉิน', onclick: (e: Event) => { if (e.target === sheet) close(); } },
    h('div', {},
      h('h2', {}, 'โทรฉุกเฉิน'),
      h('ul', { class: 'list' }, ...EMERGENCY.map((e) =>
        h('li', {}, h('a', { href: `tel:${e.tel}`, class: 'row', 'aria-label': `โทร ${e.tel} ${e.th}` }, h('strong', {}, e.tel), h('span', {}, e.th))))),
      h('p', { class: 'muted' }, 'เว็บนี้ไม่รับแจ้งเหตุ — โทรตามเบอร์ด้านบน'),
      h('button', { onclick: close }, 'ปิด')));
  const trap = trapFocus(sheet);
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else trap(e);
  };
  document.body.append(sheet);
  document.addEventListener('keydown', onKeydown);
  (sheet.querySelector('a') as HTMLElement | null)?.focus();
}

export function renderShell(root: HTMLElement, current: Tab): ShellRefs {
  const freshness = h('div', { class: 'fresh', role: 'status', 'data-testid': 'freshness' }, 'กำลังโหลดข้อมูล…');
  const brand = h('a', { href: './', class: 'brand' }, 'ท่วมไหม');
  const top = h('header', { class: 'topbar' },
    h('div', { class: 'wrap' },
      brand,
      h('button', { class: 'primary', 'data-testid': 'emergency', onclick: openEmergency }, '📞 โทรฉุกเฉิน')),
    freshness);
  const banners = h('div', { class: 'wrap', 'data-testid': 'banners' });
  const main = h('main', { class: 'wrap', id: 'main' });
  const nav = h('nav', { class: 'tabs', 'aria-label': 'เมนูหลัก' },
    ...TABS.map((t) => h('a', { href: tabHref(t.tab), 'aria-current': t.tab === navTab(current) ? 'page' : null, 'data-tab': t.tab },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, t.ico), h('span', {}, t.label))));
  root.replaceChildren(top, banners, main, nav);
  return { main, freshness, banners, nav, brand };
}

/** Recompute nav/brand hrefs so they carry the current `location.hash` — needed whenever
 *  storage isn't persistent (e.g. LINE in-app browser) and places live only in the URL. */
export function refreshNavHashes(shell: ShellRefs): void {
  shell.brand.setAttribute('href', `./${location.hash}`);
  for (const a of Array.from(shell.nav.querySelectorAll<HTMLAnchorElement>('a[data-tab]'))) {
    const tab = a.dataset.tab as Tab;
    a.setAttribute('href', tabHref(tab));
  }
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-tab-link]'))) {
    a.setAttribute('href', tabHref(a.dataset.tabLink as Tab));
  }
}

type LinkAttrs = Record<string, string | null | undefined>;
/** An in-page link to another tab (outside the bottom nav) that always carries the *current*
 *  `#p=` hash: refreshed by refreshNavHashes and recomputed on activation, so a link built
 *  before a place was added (e.g. the add panel, which lives for the whole page) never drops it. */
export function tabLink(tab: Tab, attrs: LinkAttrs, text: string): HTMLAnchorElement {
  const a = h('a', { ...attrs, href: tabHref(tab), 'data-tab-link': tab }, text);
  // Runs before the browser follows the link, so the navigation uses the updated href.
  const sync = () => a.setAttribute('href', tabHref(tab));
  a.addEventListener('click', sync);
  a.addEventListener('auxclick', sync);
  a.addEventListener('focus', sync);
  a.addEventListener('pointerdown', sync);
  return a;
}
