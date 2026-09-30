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
