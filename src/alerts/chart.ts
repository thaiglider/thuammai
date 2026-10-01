import { setImmediate as yieldNow } from 'node:timers/promises';
import { CAPS } from '../core/alert-config';
import { parseWeekFile, weekFile, type WeekFile } from '../core/week';
import { weekSvg } from '../core/week-svg';
import type { Counts } from './log';

/** SVG → PNG. Injected so src/alerts stays free of the native renderer (server/src/alerts/render.ts). */
export type RenderPng = (svg: string) => Uint8Array;
/** One station's chart for one snapshot; `fileId` is filled in after the first upload to Telegram. */
export interface ChartEntry { png: Uint8Array; file: WeekFile; fileId: string | null }
export interface ChartSource {
  /** null = no chart (no file, not a week file, nothing to draw, the renderer failed, or over the
   *  per-snapshot cap). Never throws; `counts` gets chart_render / chart_fetch_err / chart_render_err. */
  get(gen: string, stationId: string, counts: Counts): Promise<ChartEntry | null>;
}
export const WEEK_FETCH = { timeoutMs: 5000, maxChars: 256 * 1024 } as const;

const bump = (c: Counts, k: string) => { c[k] = (c[k] ?? 0) + 1; };

/** Week files of the published site, drawn once per (snapshot, station) and kept until the next
 *  snapshot (Plan O spec §3.2). "No chart" is kept too, so a station is fetched once per snapshot. */
export function chartSource(o: { fetch: typeof fetch; siteUrl: string; render: RenderPng; maxPerGen?: number }): ChartSource {
  const max = o.maxPerGen ?? CAPS.tgChartsPerRun;
  let gen = '';
  let cache = new Map<string, Promise<ChartEntry | null>>();
  /** Never rejects: every step that can throw is inside a try. */
  const load = async (g: string, stationId: string, counts: Counts): Promise<ChartEntry | null> => {
    let file: WeekFile | null;
    try {
      const name = weekFile(stationId);
      if (!name) return null;
      const r = await o.fetch(`${o.siteUrl}data/week/${name}.json?t=${Date.parse(g)}`, { signal: AbortSignal.timeout(WEEK_FETCH.timeoutMs) });
      if (r.status === 404) return null; // a station without a week file: not an error
      const body = r.ok ? await r.text() : '';
      const parsed = body && body.length <= WEEK_FETCH.maxChars ? parseWeekFile(JSON.parse(body)) : null;
      file = parsed && parsed.id === stationId ? parsed : null;
    } catch {
      file = null;
    }
    if (!file) { bump(counts, 'chart_fetch_err'); return null; }
    try {
      const svg = weekSvg(file, Date.parse(g));
      if (!svg) return null;
      try {
        const png = o.render(svg);
        bump(counts, 'chart_render');
        return { png, file, fileId: null };
      } finally {
        await yieldNow(); // drawing is synchronous: let the 30-second heartbeat timer run between charts
      }
    } catch {
      bump(counts, 'chart_render_err');
      return null;
    }
  };
  return {
    /** The promise is stored before it is awaited, in the map of this snapshot: concurrent callers share
     *  one load, count against the cap, and a late load never lands in a newer snapshot's map. */
    get(g, stationId, counts) {
      if (g !== gen) { gen = g; cache = new Map(); }
      const mine = cache;
      if (mine.has(stationId)) return mine.get(stationId)!;
      if (mine.size >= max) return Promise.resolve(null);
      const p = load(g, stationId, counts);
      mine.set(stationId, p);
      return p;
    },
  };
}
