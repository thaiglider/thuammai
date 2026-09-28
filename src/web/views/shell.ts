import { EMERGENCY } from '../../core/labels';
import { h } from '../lib/dom';

export type Tab = 'home' | 'areas' | 'help' | 'sources' | 'about';
export interface ShellRefs { main: HTMLElement; freshness: HTMLElement; banners: HTMLElement; nav: HTMLElement; brand: HTMLAnchorElement }

const TABS: { tab: Tab; ico: string; label: string }[] = [
  { tab: 'home', ico: '🏠', label: 'จุดของฉัน' },
  { tab: 'areas', ico: '🗺️', label: 'รายพื้นที่' },
  { tab: 'help', ico: '🆘', label: 'ช่วยเหลือ' },
  { tab: 'sources', ico: 'ℹ️', label: 'ข้อมูล' },
  { tab: 'about', ico: '⚙️', label: 'ตั้งค่า' },
];

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
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'โทรฉุกเฉิน', onclick: (e: Event) => { if (e.target === sheet) close(); } },
    h('div', {},
      h('h2', {}, 'โทรฉุกเฉิน'),
      h('ul', { class: 'list' }, ...EMERGENCY.map((e) =>
        h('li', {}, h('a', { href: `tel:${e.tel}`, class: 'row', 'aria-label': `โทร ${e.tel} ${e.th}` }, h('strong', {}, e.tel), h('span', {}, e.th))))),
      h('p', { class: 'muted' }, 'เว็บนี้ไม่รับแจ้งเหตุ — โทรตามเบอร์ด้านบน'),
      h('button', { onclick: close }, 'ปิด')));
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
    ...TABS.map((t) => h('a', { href: tabHref(t.tab), 'aria-current': t.tab === current ? 'page' : null, 'data-tab': t.tab },
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
}
