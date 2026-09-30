import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { getJson, getText } from './http';

export interface Fetcher {
  json(url: string, headers?: Record<string, string>, opts?: { timeoutMs?: number; retries?: number }): Promise<unknown>;
  text(url: string, headers?: Record<string, string>): Promise<string>;
  /** POST a form body once (no retry) and parse JSON; optional so test doubles may omit it. */
  postJson?(url: string, body: string, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export function liveFetcher(): Fetcher {
  return {
    json: (url, headers, opts) => getJson(url, { headers, ...opts }),
    text: (url, headers) => getText(url, { headers }),
    postJson: async (url, body, opts) => {
      const text = await getText(url, {
        method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, retries: 0, timeoutMs: opts?.timeoutMs,
      });
      const t = text.trimStart();
      if (!t.startsWith('{')) throw new Error(`Response from ${url} is not JSON: ${t.slice(0, 60)}`);
      return JSON.parse(t);
    },
  };
}

/** Serves recorded payloads from tests/fixtures/snapshot-* for offline pipeline runs. */
export function fixtureFetcher(dir: string): Fetcher {
  const gz = (name: string) => JSON.parse(gunzipSync(readFileSync(join(dir, name))).toString('utf8'));
  let traffyPages: any[] | null = null;
  const routes: [RegExp, (url: string) => unknown][] = [
    [/\/public\/waterlevel_load/, () => gz('waterlevel_load.json.gz')],
    [/\/public\/rain_24h/, () => gz('rain_24h.json.gz')],
    [/\/public\/flood_road/, () => gz('flood_road.json.gz')],
    [/\/public\/canal_waterlevel/, () => gz('canal_waterlevel.json.gz')],
    [/\/analyst\/dam/, () => gz('dam.json.gz')],
    [/event\.longdo\.com/, () => gz('longdo.json.gz')],
    [/open-meteo\.com/, (url) => {
      const recorded = gz('openmeteo.json.gz') as any[];
      const q = new URL(url).searchParams;
      const lats = (q.get('latitude') ?? '').split(',').filter(Boolean).map(Number);
      const lons = (q.get('longitude') ?? '').split(',').filter(Boolean).map(Number);
      return lats.map((latitude, i) => ({
        ...recorded[i % recorded.length],
        latitude,
        longitude: lons[i] ?? recorded[i % recorded.length].longitude,
      }));
    }],
    [/publicapi\.traffy\.in\.th/, (url) => {
      traffyPages ??= gz('traffy_pages.json.gz') as any[];
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      return traffyPages[Math.floor(offset / 100)] ?? { results: [] };
    }],
  ];
  return {
    async postJson(url) {
      if (/overpass/.test(url)) return gz('overpass_hospitals.json.gz');
      throw new Error(`no fixture for ${url}`);
    },
    async json(url) {
      const hit = routes.find(([re]) => re.test(url));
      if (!hit) throw new Error(`no fixture for ${url}`);
      return hit[1](url);
    },
    async text(url) {
      if (/data\.tmd\.go\.th/.test(url)) return readFileSync(join(dir, 'tmd.xml'), 'utf8');
      throw new Error(`no fixture for ${url}`);
    },
  };
}
