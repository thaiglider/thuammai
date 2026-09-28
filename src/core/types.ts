export const SCHEMA = 1;

export type Level = 0 | 1 | 2 | 3 | 4;
export type Kind = 'river' | 'canal' | 'road' | 'rain' | 'dam';
export type Flag =
  | 'stale' | 'held' | 'step5cm' | 'stuck' | 'erratic' | 'out_of_range'
  | 'bank_invalid' | 'bma_thresh_invalid' | 'tidal' | 'backflow';

/** A station reading after status computation (what we publish). */
export interface Observation {
  id: string;            // `${kind}:${oldcode|id}`
  kind: Kind;
  name: string;
  lat: number;
  lon: number;
  prov: string;          // 2-digit province code
  amphoe?: string;       // Thai amphoe/khet name from source
  district?: string;     // BKK khet code (4 digits) when prov === '10'
  t: string;             // measurement time, ISO +07:00
  v: number;             // river/canal: m MSL · road: cm · rain: mm 24h · dam: % capacity
  bank?: number;         // river: min_bank · canal: validated bank (m MSL)
  bmaCrit?: number;      // canal: BMA critical level (validated)
  sit?: 1 | 2 | 3 | 4 | 5; // river: ThaiWater situation_level
  vOut?: number;         // canal: river-side level at the gate
  q?: number;            // river discharge m3/s
  r1h?: number;          // rain: mm last hour
  r3h?: number;          // rain: mm last 3 h (from history)
  slope3h?: number;      // river/canal m/h, road cm/h (regression over 3 h)
  level: Level;          // final station level (base + rise, or held)
  held?: { level: Level; lastFreshAt: string };
  flags?: Flag[];
}

/** Parsed reading before status computation. */
export type RawObs = Omit<Observation, 'level' | 'held' | 'r3h' | 'slope3h'>;

export type Reporter = 'highway' | 'itic' | 'public' | 'traffy';

export interface FloodEvent {
  id: string;            // `longdo:${eid}` | `traffy:${ticket_id}`
  source: 'longdo' | 'traffy';
  reporter: Reporter;
  by?: string;           // contributor name (Longdo public reports), used to count distinct senders
  lat: number;
  lon: number;
  t: string;             // ISO +07:00
  title: string;         // sanitized, ≤140 chars
  passable?: boolean | null;
  depthCm?: number | null;
}

export interface ForecastPoint {
  id: string;            // 'p10' province, 'd1001' BKK district
  lat: number;
  lon: number;
  start: string;         // ISO +07:00 of mm[0]
  mm: number[];          // hourly precipitation, next 6 hours
}

export interface TmdWarning { title: string; body: string; issued: string | null }

export type SourceId = 'river' | 'rain' | 'road' | 'canal' | 'dam' | 'longdo' | 'traffy' | 'forecast' | 'tmd';

export interface SourceHealth {
  id: SourceId;
  ok: boolean;
  count: number;
  newest: string | null;
  lagMin: number | null;
  windowH?: number;
  error?: string;
  carriedFrom?: string;
}

/** Fresh rain station that reported zero rain: [lat, lon] (province given by the file it is in). */
export type Rain0 = [number, number];

export interface ProvinceGeo { code: string; th: string; en: string; lat: number; lon: number; bbox: [number, number, number, number] }
