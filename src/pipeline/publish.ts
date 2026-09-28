import { assessArea, districtOf } from '../core/area';
import { isLiveEvent } from '../core/risk';
import type { History, Sample } from '../core/history';
import { HISTORY, THRESHOLDS_VERSION } from '../core/thresholds';
import { toIso07 } from '../core/time';
import { SCHEMA, type Observation, type Rain0 } from '../core/types';
import type { Collected } from './collect';
import { renderAreaPage, renderIndex, type IndexRow, type UpstreamRow } from './render';
import type { PipelineState } from './state';
import type { StaticData } from './static-data';

export interface PublishInput {
  now: Date; obs: Observation[]; collected: Collected; sd: StaticData;
  history: History; historyH: number; state: PipelineState;
}

const CHAIN_PROVS = new Set(['60', '18', '17', '15', '14', '12', '10']);

export interface SlotSeries { t0: number; step: number; v: (number | null)[] }

export function toSlots(s: readonly Sample[]): SlotSeries {
  const slotMs = HISTORY.slotMin * 60e3;
  const k0 = Math.floor(s[0]!.t / slotMs);
  const v: (number | null)[] = [];
  for (const x of s) {
    const i = Math.floor(x.t / slotMs) - k0;
    if (i < 0) continue; // samples are appended in time order; ignore anything out of order
    while (v.length < i) v.push(null);
    v[i] = x.v;
  }
  return { t0: (k0 * slotMs) / 1000, step: slotMs / 1000, v };
}

export function buildOutputs(inp: PublishInput): Map<string, string> {
  const { now, obs, collected: c, sd } = inp;
  const gen = toIso07(now);
  const head = { generatedAt: gen, schema: SCHEMA, thresholdsVersion: THRESHOLDS_VERSION };
  const files = new Map<string, string>();
  const put = (path: string, data: unknown) => files.set(path, JSON.stringify(data));

  for (const o of obs) if (o.prov === '10' && !o.district) o.district = districtOf(o.amphoe, sd.districts);

  // per-province observations; rain: fresh non-zero → obs, fresh zero → rain0, stale dropped
  const byProv = new Map<string, { obs: Observation[]; rain0: Rain0[] }>();
  for (const p of sd.provinces) byProv.set(p.code, { obs: [], rain0: [] });
  for (const o of obs) {
    const bucket = byProv.get(o.prov);
    if (!bucket) continue;
    if (o.kind === 'rain') {
      if (o.level === 0) continue;
      if (o.v > 0 || (o.r1h ?? 0) > 0) bucket.obs.push(o);
      else bucket.rain0.push([o.lat, o.lon]);
      continue;
    }
    bucket.obs.push(o);
  }
  for (const [prov, b] of byProv) put(`data/obs/${prov}.json`, { ...head, prov, obs: b.obs, rain0: b.rain0 });
  put('data/obs/flagged.json', { ...head, obs: obs.filter((o) => o.level >= 2) });

  put('data/events.json', { ...head, windowH: c.traffyWindowH, events: [...c.longdo, ...c.traffy].filter((e) => isLiveEvent(e, now)) });
  put('data/forecast.json', { ...head, points: c.forecast });

  // upstream (display only)
  const riverByCode = new Map(obs.filter((o) => o.kind === 'river').map((o) => [o.id.slice('river:'.length), o]));
  const upstream: UpstreamRow[] = sd.chain.map((s) => {
    const o = riverByCode.get(s.code);
    return { code: s.code, th: s.th, v: o?.v ?? null, bank: o?.bank ?? null, q: o?.q ?? null, level: o?.level ?? 0, t: o?.t ?? null, qThresholds: s.qThresholds };
  });
  put('data/upstream.json', { ...head, stations: upstream });

  // areas + pages
  const areaRows: (IndexRow & { top: string[]; n3: number; n4: number })[] = [];
  const provName = new Map(sd.provinces.map((p) => [p.code, p.th]));
  for (const p of sd.provinces) {
    const inArea = byProv.get(p.code)!.obs;
    const area = assessArea(inArea);
    areaRows.push({ code: p.code, kind: 'province', name: p.th, level: area.level, N: area.N, n2: area.n2, n3: area.n3, n4: area.n4, top: area.top });
    files.set(`p/${p.code}.html`, renderAreaPage({
      code: p.code, kind: 'province', name: p.th, lat: p.lat, lon: p.lon, area,
      obs: inArea.filter((o) => o.kind !== 'dam'), dams: inArea.filter((o) => o.kind === 'dam'),
      upstream: CHAIN_PROVS.has(p.code) ? upstream : undefined,
    }, gen));
  }
  const bkkObs = byProv.get('10')!.obs;
  for (const d of sd.districts) {
    const inArea = bkkObs.filter((o) => o.district === d.code);
    const area = assessArea(inArea);
    areaRows.push({ code: d.code, kind: 'district', name: d.th, level: area.level, N: area.N, n2: area.n2, n3: area.n3, n4: area.n4, top: area.top });
    files.set(`p/${d.code}.html`, renderAreaPage({
      code: d.code, kind: 'district', name: d.th, parentName: provName.get('10'), lat: d.lat, lon: d.lon, area,
      obs: inArea, dams: [],
    }, gen));
  }
  put('data/areas.json', { ...head, areas: areaRows });
  files.set('index.html', renderIndex(areaRows, gen));

  // history for charts: river/canal/road stations at level ≥2 (or held) only, as 30-min slots
  // { t0: epochSec of the first slot, step: 1800, v: last value per slot, null for gaps }.
  for (const [prov, b] of byProv) {
    const series: Record<string, SlotSeries> = {};
    for (const o of b.obs) {
      if (o.kind === 'rain' || o.kind === 'dam' || (o.level < 2 && !o.held)) continue;
      const s = inp.history.series[o.id];
      if (s?.length) series[o.id] = toSlots(s);
    }
    put(`data/history/${prov}.json`, { ...head, series });
  }

  put('data/meta.json', { ...head, historyH: Math.round(inp.historyH * 10) / 10, sources: c.health, tmd: c.tmd, swKill: false });
  put('data/_state.json', inp.state);
  files.set('.nojekyll', '');
  return files;
}
