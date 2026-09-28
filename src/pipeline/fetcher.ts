import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { getJson, getText } from './http';

export interface Fetcher {
  json(url: string, headers?: Record<string, string>): Promise<unknown>;
  text(url: string, headers?: Record<string, string>): Promise<string>;
}

export function liveFetcher(): Fetcher {
  return {
    json: (url, headers) => getJson(url, { headers }),
    text: (url, headers) => getText(url, { headers }),
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
