import { h } from '../lib/dom';
import type { Env } from '../lib/env';
import { trapFocus } from '../lib/focus';

export async function sharePlaces(env: Env, url: string, text: string): Promise<'shared' | 'line' | 'copied' | 'failed' | 'cancelled'> {
  if (env.canShare && !env.isLine) {
    try {
      await navigator.share({ title: 'ท่วมไหม', text, url });
      return 'shared';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
      // any other error (unsupported, permission, …) → fall through to LINE/clipboard
    }
  }
  const full = `${text} ${url}`;
  if (env.isLine || /Android|iPhone|iPad/.test(navigator.userAgent)) {
    location.href = `https://line.me/R/share?text=${encodeURIComponent(full)}`;
    return 'line';
  }
  try { await navigator.clipboard.writeText(full); return 'copied'; } catch { return 'failed'; }
}

export async function openQr(url: string): Promise<void> {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const img = h('img', { src: qr.createDataURL(6, 8), alt: 'QR code ของลิงก์จุดทั้งหมด', width: 264, height: 264 });
  const opener = document.activeElement as HTMLElement | null;
  const close = () => {
    sheet.remove();
    document.removeEventListener('keydown', onKeydown);
    opener?.focus();
  };
  const closeBtn = h('button', { onclick: close }, 'ปิด');
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'QR code', onclick: (e: Event) => { if (e.target === sheet) close(); } },
    h('div', {}, h('h2', {}, 'สแกนเพื่อเพิ่มจุดเดียวกันในเครื่องอื่น'), img, h('p', { class: 'muted' }, url), closeBtn));
  const trap = trapFocus(sheet);
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else trap(e);
  };
  document.body.append(sheet);
  document.addEventListener('keydown', onKeydown);
  closeBtn.focus();
}
