import { fmtTime } from '../../core/time';
import { browserPushDeps, disableAlerts, enableAlerts, scheduleSync, serviceWorkerGone, syncNow, type EnableResult, type SyncResult } from '../lib/alerts-client';
import { ALERTS_PAUSED_TH, ALERTS_PRIVACY_TH, alertsCfg, alertsOn, loadAlerts, pushConfigured } from '../lib/alerts-state';
import { clear, h } from '../lib/dom';
import { trapFocus } from '../lib/focus';
import type { Place } from '../lib/places';
import type { KV } from '../lib/storage';
import type { ShellRefs } from './shell';

export const ALERTS_BUTTON_TH = 'รับแจ้งเตือนแม้ปิดเว็บ';
export const CONFIRM_TH = "จะแจ้งเตือนเมื่อจุดที่คุณติดตามถึงระดับ 'เตือนภัย' ขึ้นไป และเมื่อกลับต่ำกว่านั้นต่อเนื่อง 1 ชม. · ระบบแจ้งเตือนจะเก็บพิกัดโดยประมาณ (~100 ม.) ของจุดที่ติดตาม ไม่เก็บชื่อจุด · การแจ้งเตือนอาจช้าหรือไม่มาถึง อย่าใช้แทนประกาศทางการ";
export const IOS_GUIDE_TH = "บน iPhone/iPad ต้องเพิ่มเว็บนี้ลงหน้าจอโฮมก่อน (iOS 16.4 ขึ้นไป): 1) แตะปุ่มแชร์ของ Safari 2) เลือก 'เพิ่มไปยังหน้าจอโฮม' 3) เปิดท่วมไหมจากไอคอนบนหน้าจอโฮม แล้วแตะปุ่มนี้อีกครั้ง — จุดที่บันทึกไว้ในแอปจากหน้าจอโฮมแยกจาก Safari ใช้ลิงก์ 'ส่งจุดทั้งหมด' เพื่อย้ายจุด";
export const ENABLE_TEXT: Record<Exclude<EnableResult, 'ok'>, string> = {
  denied: 'ยังไม่ได้อนุญาตการแจ้งเตือน — เปิดได้ในการตั้งค่าเบราว์เซอร์',
  browser: 'เบราว์เซอร์นี้เปิดการแจ้งเตือนไม่ได้',
  unavailable: 'ตอนนี้เปิดการแจ้งเตือนไม่ได้ (ระบบแจ้งเตือนขัดข้อง) — ลองใหม่ภายหลัง เว็บยังใช้ได้ตามปกติ',
  rate: 'ลองใหม่ในอีก 1 นาที',
  limited: 'เพิ่มจุดใหม่ได้วันละไม่เกิน 30 จุด — ลองใหม่พรุ่งนี้',
  // Plan E adds "ใช้ Telegram หรือ" once the bot exists (spec §6.1).
  full: 'ระบบแจ้งเตือนรับผู้ใช้เต็มชั่วคราว — เปิดเว็บดูเป็นระยะ',
};
export const SYNC_TEXT: Partial<Record<SyncResult, string>> = {
  failed: 'ยังซิงก์จุดกับระบบแจ้งเตือนไม่ได้ — จะลองใหม่อัตโนมัติ',
  revoked: 'การแจ้งเตือนถูกปิดจากเบราว์เซอร์',
  removed: 'ไม่มีจุดให้ติดตาม — ปิดการแจ้งเตือนแล้ว',
  paused: ALERTS_PAUSED_TH,
  limited: 'เพิ่มจุดใหม่ได้วันละไม่เกิน 30 จุด — ลองใหม่พรุ่งนี้',
};
export const CLEAR_LOCAL_TH = 'ลบการตั้งค่าแจ้งเตือนในเครื่องนี้';
export const CLEARED_LOCAL_TH = 'ลบการตั้งค่าแจ้งเตือนในเครื่องนี้แล้ว';
export const enabledText = (n: number): string => `เปิดแจ้งเตือนแล้ว — ติดตาม ${n} จุด`;

export interface AlertsViewCtx { kv: KV; base: string; shell: ShellRefs; getPlaces(): Place[] }

/** The confirm sheet (spec §6.1 step 1). `onYes` runs inside the tap, so the permission prompt
 *  that follows counts as a user gesture on iOS. */
function openConfirm(onYes: () => void): void {
  const opener = document.activeElement as HTMLElement | null;
  const close = () => { sheet.remove(); document.removeEventListener('keydown', onKey); opener?.focus(); };
  const yes = h('button', { class: 'primary', 'data-testid': 'alerts-confirm-yes', onclick: () => { close(); onYes(); } }, 'เปิดแจ้งเตือน');
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'alerts-confirm-title', 'data-testid': 'alerts-confirm', onclick: (e: Event) => { if (e.target === sheet) close(); } },
    h('div', {},
      h('h2', { id: 'alerts-confirm-title' }, ALERTS_BUTTON_TH),
      h('p', {}, CONFIRM_TH),
      h('div', { class: 'actions' }, yes, h('button', { 'data-testid': 'alerts-confirm-no', onclick: close }, 'ไม่'))));
  const trap = trapFocus(sheet);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); else trap(e); };
  document.body.append(sheet);
  document.addEventListener('keydown', onKey);
  yes.focus();
}

export type SectionMode = 'push' | 'ios-guide' | 'paused';

/** I3: alerts on in this phone's settings, but nothing can arrive. Says so, and offers to clear
 *  the local setting (which also deletes on the server when that is still possible). */
function paused(host: HTMLElement, o: AlertsViewCtx, testid: string, after: () => void): void {
  host.append(
    h('p', { role: 'status', 'data-testid': testid }, ALERTS_PAUSED_TH),
    h('button', { 'data-testid': 'alerts-clear-local', onclick: (e: Event) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      void disableAlerts(browserPushDeps(o.kv, o.base)).then(after);
    } }, CLEAR_LOCAL_TH));
}

/** The section under the cards on จุดของฉัน. */
export function mountAlerts(host: HTMLElement, o: AlertsViewCtx, mode: SectionMode): void {
  clear(host);
  host.dataset.mode = mode;
  host.append(h('h2', {}, 'การแจ้งเตือน'));
  if (mode === 'paused') {
    paused(host, o, 'alerts-paused', () => {
      clear(host);
      host.append(h('h2', {}, 'การแจ้งเตือน'), h('p', { role: 'status', 'data-testid': 'alerts-cleared' }, CLEARED_LOCAL_TH));
    });
    return;
  }
  if (mode === 'push' && alertsOn(o.kv)) {
    host.append(
      h('p', { 'data-testid': 'alerts-status' }, enabledText(o.getPlaces().length)),
      h('p', { class: 'muted' }, 'เลิกรับแจ้งเตือนได้ที่เมนู'));
    // No service worker (e.g. swKill) → no push can arrive: never keep saying "on".
    void serviceWorkerGone(browserPushDeps(o.kv, o.base)).then((gone) => {
      if (gone && host.isConnected && host.dataset.mode === 'push' && alertsOn(o.kv)) mountAlerts(host, o, 'paused');
    });
    return;
  }
  const msg = h('p', { role: 'alert', 'data-testid': 'alerts-msg' });
  const guide = h('p', { 'data-testid': 'alerts-ios-guide', hidden: true }, IOS_GUIDE_TH);
  const btn = h('button', { class: 'primary', 'data-testid': 'alerts-enable', onclick: () => {
    msg.textContent = '';
    if (mode === 'ios-guide') { guide.hidden = false; return; }
    openConfirm(() => {
      btn.disabled = true;
      void enableAlerts(browserPushDeps(o.kv, o.base), o.getPlaces()).then((r) => {
        btn.disabled = false;
        if (r === 'ok') mountAlerts(host, o, mode);
        else msg.textContent = ENABLE_TEXT[r];
      });
    });
  } }, ALERTS_BUTTON_TH);
  host.append(btn, guide, msg);
}

/** m10: after a sync changed what is true (revoked, removed, paused), redraw the sections that
 *  are on screen so they never keep saying "on". */
function redraw(o: AlertsViewCtx, r: SyncResult): void {
  if (r !== 'revoked' && r !== 'removed' && r !== 'paused') return;
  const home = document.querySelector<HTMLElement>('[data-testid="alerts"]');
  if (home && (home.dataset.mode === 'push' || home.dataset.mode === 'paused')) {
    if (r === 'paused') { if (home.dataset.mode !== 'paused') mountAlerts(home, o, 'paused'); }
    else if (!o.getPlaces().length) home.remove();
    else mountAlerts(home, o, 'push');
  }
  const menu = document.querySelector<HTMLElement>('[data-testid="alerts-menu"]');
  if (menu) renderAlertsMenu(menu, o);
}

function showSyncBanner(shell: ShellRefs, r: SyncResult): void {
  shell.banners.querySelector('[data-testid="alerts-banner"]')?.remove();
  const text = SYNC_TEXT[r];
  if (!text) return;
  const bar = h('div', { class: 'banner', role: 'status', 'data-testid': 'alerts-banner' },
    h('span', {}, text),
    h('button', { onclick: () => bar.remove() }, 'ปิด'));
  shell.banners.prepend(bar);
}

/** After every place edit while alerts are on (spec §6.2). */
export function onPlacesSaved(o: AlertsViewCtx): void {
  scheduleSync(browserPushDeps(o.kv, o.base), o.getPlaces, (r) => { showSyncBanner(o.shell, r); redraw(o, r); });
}

let retryWired = false;
/** On page open while alerts are on: check the subscription, retry pending syncs when back
 *  online or visible again (spec §6.2). */
export function onOpen(o: AlertsViewCtx): void {
  const run = () => void syncNow(browserPushDeps(o.kv, o.base), o.getPlaces()).then((r) => { showSyncBanner(o.shell, r); redraw(o, r); });
  run();
  if (retryWired) return;
  retryWired = true;
  // A per-day cap (holdUntil) is not retried on every visibility change (m4).
  const retry = () => {
    const st = loadAlerts(o.kv);
    if (st?.pending && !(st.holdUntil && Date.now() < Date.parse(st.holdUntil))) run();
  };
  window.addEventListener('online', retry);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) retry(); });
}

/** เมนู → การแจ้งเตือน (spec §6.5). */
export function renderAlertsMenu(host: HTMLElement, o: AlertsViewCtx): void {
  clear(host);
  const st = loadAlerts(o.kv);
  host.append(h('h2', {}, 'การแจ้งเตือน'));
  const privacy = h('p', { class: 'muted' }, ALERTS_PRIVACY_TH);
  const showPaused = () => {
    clear(host);
    host.append(h('h2', {}, 'การแจ้งเตือน'));
    paused(host, o, 'alerts-menu-status', () => renderAlertsMenu(host, o));
    host.append(privacy);
  };
  if (st && !pushConfigured(alertsCfg())) { showPaused(); return; }
  if (!st && !pushConfigured(alertsCfg())) { host.remove(); return; }
  host.append(h('p', { 'data-testid': 'alerts-menu-status' }, st ? `เปิดอยู่ · ติดตาม ${o.getPlaces().length} จุด · ซิงก์ล่าสุด ${fmtTime(st.syncedAt)}` : 'ปิดอยู่'));
  if (st) {
    void serviceWorkerGone(browserPushDeps(o.kv, o.base)).then((gone) => { if (gone && host.isConnected && loadAlerts(o.kv)) showPaused(); });
    host.append(h('button', { 'data-testid': 'alerts-disable', onclick: (e: Event) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      void disableAlerts(browserPushDeps(o.kv, o.base)).then(() => renderAlertsMenu(host, o));
    } }, 'เลิกรับแจ้งเตือน'));
  }
  host.append(privacy);
}
