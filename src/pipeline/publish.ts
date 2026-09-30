import { assessArea, districtOf } from '../core/area';
import { isLiveEvent, isUrgentReport } from '../core/risk';
import type { History } from '../core/history';
import { THRESHOLDS_VERSION } from '../core/thresholds';
import { toIso07 } from '../core/time';
import { SCHEMA, type Observation, type Rain0 } from '../core/types';
import type { WeekStore } from '../core/week';
import type { Collected } from './collect';
import { renderAreaPage, renderIndex, type IndexRow, type UpstreamRow } from './render';
import type { PipelineState } from './state';
import { provinceAt, type StaticData } from './static-data';
import { weekOutputs } from './week';

export interface PublishInput {
  now: Date; obs: Observation[]; collected: Collected; sd: StaticData;
  history: History; historyH: number; state: PipelineState;
  /** Hourly 7-day water history; one data/week/* file is published per station with a series. */
  week: WeekStore;
  /** Serialized, validated skill.json (see loadSkill); omitted from the output when null/undefined. */
  skill?: string | null;
  /** Validated public origin for canonical links on p/*.html; empty/omitted = none. */
  publicOrigin?: string;
}

const CHAIN_PROVS = new Set(['60', '18', '17', '15', '14', '12', '10']);

export function buildOutputs(inp: PublishInput): Map<string, string> {
  const { now, obs, collected: c, sd } = inp;
  const gen = toIso07(now);
  const origin = inp.publicOrigin ?? '';
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

  // OSM hospitals: one file per province that has any (written only when a list exists).
  const hospByProv = new Map<string, [string, string, number, number][]>();
  for (const x of c.hospitals) {
    const prov = provinceAt(x.lat, x.lon, sd);
    if (prov) (hospByProv.get(prov) ?? hospByProv.set(prov, []).get(prov)!).push([x.osmId, x.name, x.lat, x.lon]);
  }
  for (const [prov, items] of hospByProv) put(`data/hospitals/${prov}.json`, { ...head, fetchedAt: c.hospitalsFetchedAt, items });

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
  // Provinces holding an urgent report — confirms a river-only 4 (spec 2026-10-01 §3). Districts get none.
  const urgentProvs = new Set([...c.longdo, ...c.traffy].filter((e) => isUrgentReport(e, now)).map((e) => provinceAt(e.lat, e.lon, sd)));
  for (const p of sd.provinces) {
    const inArea = byProv.get(p.code)!.obs;
    const area = assessArea(inArea, { urgentReport: urgentProvs.has(p.code) });
    areaRows.push({ code: p.code, kind: 'province', name: p.th, level: area.level, N: area.N, n2: area.n2, n3: area.n3, n4: area.n4, top: area.top });
    files.set(`p/${p.code}.html`, renderAreaPage({
      code: p.code, kind: 'province', name: p.th, lat: p.lat, lon: p.lon, area,
      obs: inArea.filter((o) => o.kind !== 'dam'), dams: inArea.filter((o) => o.kind === 'dam'),
      upstream: CHAIN_PROVS.has(p.code) ? upstream : undefined,
    }, gen, origin));
  }
  const bkkObs = byProv.get('10')!.obs;
  for (const d of sd.districts) {
    const inArea = bkkObs.filter((o) => o.district === d.code);
    const area = assessArea(inArea);
    areaRows.push({ code: d.code, kind: 'district', name: d.th, level: area.level, N: area.N, n2: area.n2, n3: area.n3, n4: area.n4, top: area.top });
    files.set(`p/${d.code}.html`, renderAreaPage({
      code: d.code, kind: 'district', name: d.th, parentName: provName.get('10'), lat: d.lat, lon: d.lon, area,
      obs: inArea, dams: [],
    }, gen, origin));
  }
  put('data/areas.json', { ...head, areas: areaRows });
  files.set('p/index.html', renderIndex(areaRows, gen, origin));

  for (const [path, body] of weekOutputs(inp.week, obs, head)) files.set(path, body);

  if (inp.skill) files.set('data/skill.json', inp.skill);
  put('data/meta.json', { ...head, historyH: Math.round(inp.historyH * 10) / 10, sources: c.health, tmd: c.tmd, swKill: false });
  put('data/_state.json', inp.state);
  files.set('.nojekyll', '');
  return files;
}
