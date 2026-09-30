import { inThailand } from '../../core/geo';
import type { RelayCanal, RelayPayload, RelayRoad } from '../../core/relay-types';
import { ROAD } from '../../core/thresholds';
import type { RawObs } from '../../core/types';
import type { Fetcher } from '../fetcher';
import { canalFields } from './thaiwater';

export const RELAY_URL_DEFAULT = 'https://flood-api.thaiglider.com/v1/relay/bma';
/** Relay data older than this (by its own fetchedAt) is ignored; more than FUTURE_MIN ahead is clock nonsense. */
export const RELAY_MAX_AGE_MIN = 20;
const FUTURE_MIN = 10;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const opt = (x: number | null | undefined): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

export interface BmaResult { road: RawObs[]; canal: RawObs[] }

/** GET the relay body; throws on HTTP/network errors (one attempt, 20 s) and on unusable data. */
export async function fetchBma(f: Fetcher, token: string, url: string, now: Date): Promise<BmaResult> {
  const body = (await f.json(url, { Authorization: `Bearer ${token}` }, { timeoutMs: 20_000, retries: 0 })) as Partial<RelayPayload> | null;
  const at = typeof body?.fetchedAt === 'string' ? Date.parse(body.fetchedAt) : NaN;
  if (!body || Number.isNaN(at)) throw new Error('relay has no usable data');
  const ageMin = (now.getTime() - at) / 60_000;
  if (ageMin > RELAY_MAX_AGE_MIN) throw new Error(`relay data stale (${Math.round(ageMin)} min)`);
  if (ageMin < -FUTURE_MIN) throw new Error('relay data is from the future');
  const tOk = (t: string) => { const d = Date.parse(t); return !Number.isNaN(d) && (d - now.getTime()) / 60_000 <= FUTURE_MIN; };
  return {
    road: (Array.isArray(body.road) ? body.road : []).flatMap((x) => (tOk(x.t) ? roadObs(x) : [])),
    canal: (Array.isArray(body.canal) ? body.canal : []).flatMap((x) => (tOk(x.t) ? canalObs(x) : [])),
  };
}

function roadObs(x: RelayRoad): RawObs[] {
  if (!(x.cm >= 0 && x.cm <= ROAD.max) || !inThailand(x.lat, x.lon)) return [];
  return [{
    id: `road:${x.code}`, kind: 'road', name: x.name, lat: r5(x.lat), lon: r5(x.lon), prov: '10',
    amphoe: x.district?.replace(/^เขต\s*/, '') || undefined, t: x.t, v: r2(x.cm),
  }];
}

function canalObs(x: RelayCanal): RawObs[] {
  if (!inThailand(x.lat, x.lon)) return [];
  const banks = [opt(x.bankL), opt(x.bankR)].filter((b): b is number => b !== undefined);
  const cf = canalFields(banks.length ? Math.min(...banks) : undefined, opt(x.warn), opt(x.crit));
  return [{
    id: `canal:${x.code}`, kind: 'canal', name: x.name, lat: r5(x.lat), lon: r5(x.lon), prov: '10',
    t: x.t, v: r2(x.level), bank: cf.bank, bmaCrit: cf.bmaCrit, flags: cf.flags.length ? cf.flags : undefined,
  }];
}

const VALIDITY_FLAGS = ['bank_invalid', 'bma_thresh_invalid'];

/** Per id keep the newer reading (BMA on a tie). Where BMA has the station its name, bank and
 *  critical level always apply (so thresholds do not flap when ThaiWater catches up); ThaiWater
 *  keeps its prov/amphoe and contributes step5cm. BMA-only stations are added when `addOnly` allows
 *  (Bangkok this round). `bmaUsed` counts merged items that carry BMA data. */
export function mergeNewer(tw: RawObs[], bma: RawObs[], addOnly: (o: RawObs) => boolean = () => true): { items: RawObs[]; bmaUsed: number } {
  const byId = new Map(tw.map((o) => [o.id, o]));
  let bmaUsed = 0;
  for (const b of bma) {
    const o = byId.get(b.id);
    if (!o) {
      if (addOnly(b)) { byId.set(b.id, b); bmaUsed++; }
      continue;
    }
    bmaUsed++;
    if (Date.parse(b.t) >= Date.parse(o.t)) {
      const flags = [...(b.flags ?? []), ...(o.flags?.includes('step5cm') ? (['step5cm'] as const) : [])];
      byId.set(b.id, { ...b, prov: o.prov, amphoe: o.amphoe ?? b.amphoe, flags: flags.length ? flags : undefined });
    } else if (b.kind === 'canal') {
      const flags = [...(o.flags ?? []).filter((f) => !VALIDITY_FLAGS.includes(f)), ...(b.flags ?? [])];
      byId.set(b.id, { ...o, name: b.name, bank: b.bank, bmaCrit: b.bmaCrit, flags: flags.length ? flags : undefined });
    } else {
      byId.set(b.id, { ...o, name: b.name });
    }
  }
  return { items: [...byId.values()], bmaUsed };
}
