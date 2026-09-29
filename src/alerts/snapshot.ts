import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALERT } from '../core/alert-config';
import { buildPointInput, pointProvinces, type EventsFile, type ForecastFile, type PointInput, type ProvObsFile } from '../core/point-input';
import { SCHEMA, type ProvinceGeo, type SourceHealth } from '../core/types';

export type SnapshotReason = 'ok' | 'missing' | 'schema' | 'mixed' | 'old' | 'source';
export interface Snapshot {
  gen: string;
  ok: boolean;
  reason: SnapshotReason;
  provinces: ProvinceGeo[];
  obs: Map<string, ProvObsFile>;
  events: EventsFile | null;
  forecast: ForecastFile | null;
  /** RiskInputs memoised per province set (many places share one). */
  inputs: Map<string, PointInput>;
}

/** Water sources without which "no signal" would read as level 1 (spec §5.1 step 2, ruling 4). */
const WATER_SOURCES = ['river', 'road', 'canal'] as const;

export function loadProvinces(path = 'static/provinces.json'): ProvinceGeo[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { data: ProvinceGeo[] }).data;
}

/** The deployed data/ directory of this run (artifact "snapshot"), checked for everything that
 *  would make an alert — or a clear — dishonest. `ok: false` means: send nothing this run. */
export function loadSnapshot(dir: string, provinces: ProvinceGeo[], runnerNow: Date): Snapshot {
  const read = <T>(rel: string): T | null => {
    const p = join(dir, rel);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
  };
  const empty = { provinces, obs: new Map<string, ProvObsFile>(), events: null, forecast: null, inputs: new Map<string, PointInput>() };
  const meta = read<{ generatedAt?: unknown; schema?: unknown; sources?: unknown }>('meta.json');
  if (!meta || typeof meta.generatedAt !== 'string' || !Array.isArray(meta.sources)) return { ...empty, gen: '', ok: false, reason: 'missing' };
  const gen = meta.generatedAt;
  if (meta.schema !== SCHEMA) return { ...empty, gen, ok: false, reason: 'schema' };
  const obs = new Map<string, ProvObsFile>();
  for (const p of provinces) {
    const f = read<ProvObsFile>(`obs/${p.code}.json`);
    if (!f) return { ...empty, gen, ok: false, reason: 'missing' };
    obs.set(p.code, f);
  }
  const events = read<EventsFile>('events.json');
  const forecast = read<ForecastFile>('forecast.json');
  if (!events || !forecast) return { ...empty, gen, ok: false, reason: 'missing' };
  const snap = { ...empty, gen, obs, events, forecast };
  const ats = [events.generatedAt, forecast.generatedAt, ...[...obs.values()].map((f) => f.generatedAt)];
  if (ats.some((a) => a !== gen)) return { ...snap, ok: false, reason: 'mixed' };
  const fresh = (iso: string) => runnerNow.getTime() - Date.parse(iso) <= ALERT.maxSnapshotAgeMin * 60e3; // NaN → false
  if (!fresh(gen)) return { ...snap, ok: false, reason: 'old' };
  const sources = meta.sources as SourceHealth[];
  for (const id of WATER_SOURCES) {
    const s = sources.find((x) => x && x.id === id);
    const usable = s !== undefined && (s.ok || (typeof s.carriedFrom === 'string' && fresh(s.carriedFrom)));
    if (!usable) return { ...snap, ok: false, reason: 'source' };
  }
  return { ...snap, ok: true, reason: 'ok' };
}

/** The card's RiskInput for a point, evaluated at the snapshot time (spec ruling 3). */
export function inputAt(s: Snapshot, lat: number, lon: number): PointInput {
  const provs = pointProvinces(lat, lon, s.provinces);
  const memo = provs.join(',');
  let input = s.inputs.get(memo);
  if (!input) {
    input = buildPointInput({ provs, obs: provs.map((p) => s.obs.get(p) ?? null), events: s.events, forecast: s.forecast }, new Date(s.gen), s.gen);
    s.inputs.set(memo, input);
  }
  return input;
}
