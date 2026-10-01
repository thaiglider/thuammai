/** Hourly water-level history for the 7-day chart (spec 2026-09-30 §4.1). Shared by pipeline and web. */
export interface WeekSeries { t0: number; v: (number | null)[] }
export type WeekStore = Record<string, WeekSeries>;
export interface WeekFile {
  generatedAt: string; schema: number; thresholdsVersion: string;
  id: string; kind: 'river' | 'canal' | 'road'; name: string; bank?: number; bmaCrit?: number;
  t0: number; step: 3600; v: (number | null)[];
}

/** `canal:BKK01` → `canal_BKK01`; null when nothing safe is left of the station code. */
export function weekFile(id: string): string | null {
  const i = id.indexOf(':');
  if (i <= 0) return null;
  const kind = id.slice(0, i).replace(/[^a-z]/g, '');
  const code = id.slice(i + 1).replace(/[^A-Za-z0-9_.-]/g, '');
  if (!kind || !code || /^\.+$/.test(code)) return null;
  return `${kind}_${code}`;
}

/** More than a week of hours with headroom; anything longer is not a week file. */
export const WEEK_MAX_POINTS = 400;
/** Plausible t0 (epoch seconds): 2020-01-01 to 2100-01-01 UTC; anything else is not a week file. */
export const WEEK_T0_RANGE = { min: 1_577_836_800, max: 4_102_444_800 } as const;
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A fetched week file, checked before anything draws from it (Plan O spec §3.2): null unless it
 *  is exactly the shape the pipeline publishes, with sane numbers. */
export function parseWeekFile(x: unknown): WeekFile | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (o.kind !== 'river' && o.kind !== 'canal' && o.kind !== 'road') return null;
  if (o.step !== 3600 || !Number.isSafeInteger(o.t0) || (o.t0 as number) < WEEK_T0_RANGE.min || (o.t0 as number) > WEEK_T0_RANGE.max || typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.generatedAt !== 'string') return null;
  if (!Array.isArray(o.v) || o.v.length === 0 || o.v.length > WEEK_MAX_POINTS) return null;
  if (!o.v.every((n) => n === null || (fin(n) && Math.abs(n) < 1e4))) return null;
  if ((o.bank !== undefined && !(fin(o.bank) && Math.abs(o.bank) < 1e4)) || (o.bmaCrit !== undefined && !(fin(o.bmaCrit) && Math.abs(o.bmaCrit) < 1e4))) return null;
  return o as unknown as WeekFile;
}
