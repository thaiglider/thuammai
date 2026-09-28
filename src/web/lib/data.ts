import { provincesNear } from '../../core/geo';
import type { RiskInput, ZeroRain } from '../../core/risk';
import { isSkillFile, type SkillFile } from '../../core/skill';
import type { FloodEvent, ForecastPoint, Level, Observation, ProvinceGeo, Rain0, SourceHealth, TmdWarning } from '../../core/types';

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

/** When files came from a different snapshot than meta.json — e.g. the service worker answered an
 *  obs request from its cache after a network timeout — return the oldest generatedAt involved
 *  (meta's own included); null when everything matches or meta is not known yet. */
export function snapshotMismatch(metaAt: string | null, fileAts: readonly (string | undefined)[]): string | null {
  if (!metaAt) return null;
  const all = [metaAt, ...fileAts.filter((a): a is string => typeof a === 'string')];
  if (all.every((a) => a === metaAt)) return null;
  return all.reduce((min, a) => (Date.parse(a) < Date.parse(min) ? a : min));
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

  async inputFor(lat: number, lon: number, now: Date): Promise<RiskInput & { reportWindowH: number; olderSnapshotAt: string | null }> {
    // A missing provinces file must not reject the whole card: with no provinces the input is
    // marked incomplete, which yields the safe level-0 "ข้อมูลไม่ครบ" display for the place.
    const all = await this.provinces().catch(() => null);
    const provs = all ? provincesNear(lat, lon, all, 10) : [];
    const [obsResults, events, forecast] = await Promise.all([
      Promise.allSettled(provs.map((p) => this.get<{ generatedAt: string; obs: Observation[]; rain0: Rain0[] }>(`data/obs/${p}.json`).then((r) => ({ p, ...r.data })))),
      this.get<{ generatedAt: string; events: FloodEvent[]; windowH: number }>('data/events.json').then((r) => r.data).catch(() => null),
      this.get<{ generatedAt: string; points: ForecastPoint[] }>('data/forecast.json').then((r) => r.data).catch(() => null),
    ]);
    const obs: Observation[] = [];
    const rain0: ZeroRain[] = [];
    const ats: string[] = [];
    let incomplete = !events || !forecast || provs.length === 0;
    if (events) ats.push(events.generatedAt);
    if (forecast) ats.push(forecast.generatedAt);
    for (const r of obsResults) {
      if (r.status === 'rejected') { incomplete = true; continue; }
      ats.push(r.value.generatedAt);
      obs.push(...r.value.obs);
      for (const [a, b] of r.value.rain0) rain0.push({ lat: a, lon: b, prov: r.value.p });
    }
    // Mixing snapshots silently could show "no signal" from stale files: mark incomplete (so the
    // level can never be 1) and report the oldest time so the card is greyed with it.
    const olderSnapshotAt = snapshotMismatch(this.gen, ats);
    return {
      obs, rain0, now, incomplete: incomplete || olderSnapshotAt !== null, olderSnapshotAt,
      events: events?.events ?? [], forecast: forecast?.points ?? [], reportWindowH: events?.windowH ?? 0,
    };
  }
}
