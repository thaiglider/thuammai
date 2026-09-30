import { buildPointInput, pointProvinces, type EventsFile, type ForecastFile, type PointInput, type ProvObsFile } from '../../core/point-input';
import { weekFile, type WeekFile } from '../../core/week';
import { isSkillFile, type SkillFile } from '../../core/skill';
import type { FloodEvent, Level, Observation, ProvinceGeo, SourceHealth, TmdWarning } from '../../core/types';

export { snapshotMismatch } from '../../core/point-input';

export const SUPPORTED_SCHEMA = 1;
export class SchemaMismatchError extends Error {}

export interface Fetched<T> { data: T; date: string | null }
export type Loader = <T>(path: string) => Promise<Fetched<T>>;

export interface Meta { generatedAt: string; schema: number; thresholdsVersion: string; historyH: number; sources: SourceHealth[]; tmd: TmdWarning[]; swKill: boolean }
export interface AreaRow { code: string; kind: 'province' | 'district'; name: string; level: Level; N: number; n2: number; n3: number; n4: number; top: string[] }

export function fetchLoader(base: string, fetchImpl: typeof fetch = fetch.bind(globalThis)): Loader {
  return async <T>(path: string): Promise<Fetched<T>> => {
    const bust = path.startsWith('data/') ? `${path.includes('?') ? '&' : '?'}v=${Math.floor(Date.now() / 60e3)}` : '';
    const res = await fetchImpl(`${base}${path}${bust}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return { data: (await res.json()) as T, date: res.headers.get('date') };
  };
}

export class DataStore {
  private cache = new Map<string, Promise<Fetched<unknown>>>();
  private gen: string | null = null;
  constructor(private readonly loader: Loader) {}

  private get<T>(path: string): Promise<Fetched<T>> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.loader<unknown>(path);
      p.catch(() => this.cache.delete(path));
      this.cache.set(path, p);
    }
    return p as Promise<Fetched<T>>;
  }

  /** Forget every cached data/ response (e.g. once a service worker takes control, so the next
   *  fetches go through it and land in its cache). */
  reset(): void {
    for (const k of [...this.cache.keys()]) if (k.startsWith('data/')) this.cache.delete(k);
  }

  /** Forget cached data when a new snapshot is published. */
  invalidate(generatedAt: string): void {
    if (this.gen !== generatedAt) {
      for (const k of [...this.cache.keys()]) if (k.startsWith('data/')) this.cache.delete(k);
      this.gen = generatedAt;
    }
  }

  generatedAt(): string | null { return this.gen; }

  /** One station's 7-day hourly series (loaded only when a card's chart is opened). */
  async week(id: string): Promise<WeekFile> {
    const name = weekFile(id);
    if (!name) throw new Error(`no week file for ${id}`);
    return (await this.get<WeekFile>(`data/week/${name}.json`)).data;
  }

  async meta(): Promise<{ meta: Meta; serverDate: string | null }> {
    this.cache.delete('data/meta.json');
    const { data, date } = await this.get<Meta>('data/meta.json');
    if (data.schema !== SUPPORTED_SCHEMA) throw new SchemaMismatchError(`schema ${data.schema}`);
    this.invalidate(data.generatedAt);
    return { meta: data, serverDate: date };
  }

  async areas(): Promise<AreaRow[]> {
    return (await this.get<{ areas: AreaRow[] }>('data/areas.json')).data.areas;
  }

  async provinces(): Promise<ProvinceGeo[]> {
    return (await this.get<{ data: ProvinceGeo[] }>('static/provinces.json')).data.data;
  }

  /** Nationwide stations at level ≥2 (the map's default layer). */
  async flagged(): Promise<{ generatedAt: string; obs: Observation[] }> {
    return (await this.get<{ generatedAt: string; obs: Observation[] }>('data/obs/flagged.json')).data;
  }

  /** One province's stations (shares the cache entry with inputFor). */
  async provinceObs(code: string): Promise<{ generatedAt: string; obs: Observation[] }> {
    return (await this.get<{ generatedAt: string; obs: Observation[] }>(`data/obs/${code}.json`)).data;
  }

  async events(): Promise<{ generatedAt: string; windowH: number; events: FloodEvent[] }> {
    return (await this.get<{ generatedAt: string; windowH: number; events: FloodEvent[] }>('data/events.json')).data;
  }

  /** Past accuracy (evaluate.yml); null when missing or not a skill file — the page then says so. */
  async skill(): Promise<SkillFile | null> {
    try {
      const { data } = await this.get<unknown>('data/skill.json');
      return isSkillFile(data) ? data : null;
    } catch {
      return null;
    }
  }

  async inputFor(lat: number, lon: number, now: Date): Promise<PointInput> {
    // A missing provinces file must not reject the whole card: with no provinces the input is
    // marked incomplete, which yields the safe level-0 "ข้อมูลไม่ครบ" display for the place.
    const provs = pointProvinces(lat, lon, await this.provinces().catch(() => null));
    const [obsResults, events, forecast] = await Promise.all([
      Promise.allSettled(provs.map((p) => this.get<ProvObsFile>(`data/obs/${p}.json`).then((r) => r.data))),
      this.get<EventsFile>('data/events.json').then((r) => r.data).catch(() => null),
      this.get<ForecastFile>('data/forecast.json').then((r) => r.data).catch(() => null),
    ]);
    // Mixing snapshots silently could show "no signal" from stale files: buildPointInput marks the
    // input incomplete (so the level can never be 1) and reports the oldest time for the grey card.
    return buildPointInput({ provs, obs: obsResults.map((r) => (r.status === 'fulfilled' ? r.value : null)), events, forecast }, now, this.gen);
  }
}
