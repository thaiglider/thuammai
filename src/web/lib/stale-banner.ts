import { staleAgeTh, staleUsesTh, staleWaterSources, WATER_SOURCE_TH } from '../../core/source-watch';
import type { SourceHealth } from '../../core/types';
import { h } from './dom';
import type { FreshState } from './freshness';

const ID = 'stale-sources-banner';

/** The banner text when a water source is stale at `now`, else null. Only for a fresh/late (≤60 min) snapshot:
 *  when meta itself is very late or the device is offline every source would
 *  look old, and the freshness line already says so. */
export function staleBannerText(sources: readonly SourceHealth[] | undefined, now: Date, snapshot: FreshState): string | null {
  if (snapshot !== 'fresh' && snapshot !== 'late') return null;
  const stale = staleWaterSources(sources, now);
  if (!stale.length) return null;
  const list = stale.map((s) => `${WATER_SOURCE_TH[s.id]} (ค้าง ${staleAgeTh(s.lagH)})`).join(' · ');
  return `ข้อมูลบางแหล่งหยุดอัปเดต: ${list} — ${staleUsesTh(stale, sources, now)}`;
}

/** One banner (replaced on every render, removed when all sources are fresh again). */
export function showStaleBanner(host: HTMLElement, sources: readonly SourceHealth[] | undefined, now: Date, snapshot: FreshState): void {
  host.querySelector(`[data-testid="${ID}"]`)?.remove();
  const text = staleBannerText(sources, now, snapshot);
  if (text) host.append(h('div', { class: 'banner', role: 'status', 'data-testid': ID }, h('span', {}, text)));
}
