export const THRESHOLDS_VERSION = '2026-10-01.1';

/** กทม. นนทบุรี ปทุมธานี สมุทรปราการ นครปฐม สมุทรสาคร — rules use the STATION's province. */
export const BKK_METRO: readonly string[] = ['10', '11', '12', '13', '73', '74'];

/** Freshness limit in minutes per kind; older = stale; older than ×DROP_FACTOR = not published. */
export const FRESH_MIN = { river: 180, rain: 180, road: 120, canal: 120, dam: 2880 } as const;
export const DROP_FACTOR = 4;
/** Stale-source watch (owner alert + web banner, 2026-09-30): a water source whose newest reading
 *  is this many hours old or older is "stale" — never read by the risk rules. */
export const STALE_SOURCE_H = 6;
/** Hysteresis: a stale source counts as recovered (owner notice) only once its newest reading is
 *  younger than this — stale at ≥6 h, recovered below 5 h, so a feed hovering near 6 h can't flap. */
export const STALE_SOURCE_RECOVER_H = 5;
/** The BMA relay must have failed this long before the owner hears about it. */
export const RELAY_PROBLEM_MIN = 60;
export const FUTURE_TOLERANCE_MIN = 10;

/** Thailand bounding box for coordinate sanity checks [minLon, minLat, maxLon, maxLat]. */
export const TH_BBOX = [97.3, 5.6, 105.7, 20.5] as const;

/** lrMaxDiff/bankMatch/farAbove/dropAbove: bank-quality rules of riverBank() (spec 2026-10-01 §1.1). */
export const RIVER = { fb4: 0, fb3: 0.2, fb2: 0.5, lrMaxDiff: 5, bankMatch: 0.5, farAbove: 3, dropAbove: 8 } as const;
export const CANAL = { fb4: 0, fb3: 0.3, fb2: 0.6, bankMin: 0, bankMax: 10 } as const;
export const ROAD = { l4: 30, l3: 10, l2: 5, max: 200, stuckHours: 6 } as const;
export const RAIN_BKK = { r1h3: 60, r3h3: 100, r1h2: 30, r3h2: 60 } as const;
export const RAIN_OTHER = { d3: 150, d2: 90, max: 600 } as const;
export const DAM = { l2: 100 } as const;

export const RISE = {
  windowH: 3, minPoints: 4, minR2: 0.6, fbMax: 0.5, horizonH: 3,
  dropoutStep: 0.3, dropoutReturn: 0.1,
  erraticStep: 0.3, erraticCount: 3, erraticWindowMin: 60,
} as const;
export const HELD_MAX_H = 6;
export const HISTORY = { rawH: 6, slotMin: 30, keepH: 72, minForRules: 3 } as const;

export const DIST = {
  road: { full: 1.0, far: 1.5 },
  canal: { full: 1.5, far: 3, n: 3 },
  river: { full: 2, down1: 5, far: 10, n: 2, metroDirectKm: 1 },
  rain: { far: 5, n: 3 },
  forecast: { far: 30 },
  longdoHighway: 0.3,
  longdoNear: 0.5,
  longdoFar: 1,
  traffy: 0.5,
} as const;

/** maxAgeH: a forecast whose first hour started more than this long ago is ignored (stale run). */
export const FORECAST = { mm3h: 30, mm6h: 50, hours: 6, maxAgeH: 3 } as const;
export const EVENT_AGE_H = { highway: 72, itic: 12, public: 6, traffy: 6 } as const;
export const ITIC_URGENT_H = 6;
export const TRAFFY = { minTickets: 3, deepCm: 45, deepTickets: 2, dedupM: 50, dedupH: 2, maxPages: 5, pageSize: 100, pauseMs: 1000, deadlineMs: 90_000, maxWindowH: 6 } as const;
export const CORROB = { independentKm: 0.3, familyKm: 3, drainageCanalKm: 3, drainageFb: 0.6 } as const;
export const CONF = { highRoadKm: 0.5, highCanalKm: 1, highRiverKm: 1, mediumWaterKm: 3 } as const;
/** Area rules. `riverOnly4`: without a road/canal at 4, an area needs this many river stations at 4
 *  (or an urgent report inside it) on top of the share/pair rule to reach 4 (spec 2026-10-01 §3). */
export const AREA = { minShare: 0.15, riverOnly4: 3 } as const;

/** Minimum item counts below which a successful fetch is treated as a failure (outage masked as empty). */
export const MIN_COUNT = { river: 300, rain: 1000, road: 100, canal: 100, dam: 20, longdo: 0, traffy: 0, forecast: 1, tmd: 0, hospitals: 1000, bma: 0 } as const;

/** OSM hospitals (Plan L): weekly Overpass refresh; card shows up to `max` within `nearKm`. */
export const HOSPITAL = { refreshDays: 7, minCount: 1000, nearKm: 15, max: 3, retryMin: 60 } as const;

/** Rendering-layer display cutoffs (never used by risk rules). */
export const DISPLAY = { slopeTextMinMH: 0.02, nearestWaterMaxKm: 20 } as const;

/** Skill evaluation (evaluate.yml) — how we MEASURE the rules; never read by risk.ts/station.ts. */
export const EVAL = {
  /** The spike/backtest region (Bangkok and vicinity), docs/research/backtest/2026-09-28-results.md. */
  bbox: { s: 13.55, n: 14.05, w: 100.3, e: 100.95 },
  /** Stations up to this many degrees outside the box can still decide a point inside it (river ≤10 km). */
  marginDeg: 0.1,
  /** Control grid: 0.01° points closer than gridNearKm to a fresh road/canal station. */
  gridStepDeg: 0.01,
  gridNearKm: 3,
  /** A grid point is "truly flooded" when a report is within this distance. */
  truthKm: 1,
  /** Road-sensor truth: ≥roadWetCm for a run lasting ≥roadWetMin that overlaps T ± roadTruthMin
   *  (readings looked at within T ± roadLookMin). */
  roadWetCm: ROAD.l3,
  roadWetMin: 60,
  roadTruthMin: 60,
  roadLookMin: 120,
  /** Reports filed up to this long after T still count as flooding at T. */
  reportLeadMin: 60,
  /** One evaluation snapshot per clock hour, kept this long in the pipeline state. */
  snapEveryMin: 60,
  keepH: 60,
  /** Daily tallies kept in tallies.json. */
  tallyDays: 35,
  /** Below this many samples a ratio is published as null ("ข้อมูลยังไม่พอ"). */
  minN: 30,
  /** Samples are counted per hourly snapshot, so one storm or one report yields many strongly
   *  autocorrelated samples. A ratio is also null unless it rests on independent evidence: at least
   *  minDays distinct days AND at least this many distinct units — for a hit rate the distinct truth
   *  cases (report ids / wet road sensors), for a precision the distinct warned places (0.01° grid
   *  points / road sensors). */
  minDays: 3,
  minTruthUnits: { reports: 10, road: 5 },
  minFlagUnits: { reports: 10, road: 5 },
  /** The page says "ดีกว่าการเดาสุ่ม" only from this lift; below liftWorse it says worse than chance. */
  liftBetter: 1.1,
  liftWorse: 0.9,
  /** The sources page says the result is old from this many days. */
  staleDays: 3,
} as const;

/** Tracking targets shown on the sources page (spec §7) — information, not a deploy gate. */
export const SKILL_TARGET = { level: 3, precision: 0.5, hit: 0.6 } as const;

/** Situation/trend display (spec 2026-09-30 §5–6) — never changes a station or point level. */
export const TREND = { stableCmH: 1, fastCmH: 5 } as const;
/** A station counts as "was high" (RECOVERY) this long after its last fresh level ≥3. */
export const RECOVERY_H = 24;
/** Exit/area facets (spec §8). */
export const ACCESS = { sensorKm: 1.0, reportKm: 0.5, areaKm: 3, exitMaxKm: 3, waterCm: 5, blockedCm: 30 } as const;
/** Hourly history kept for the 7-day chart (spec §4.1). */
export const WEEK = { hours: 168 } as const;
export type Vehicle = 'walk' | 'motorcycle' | 'car' | 'pickup';
export const VEHICLES: readonly Vehicle[] = ['walk', 'motorcycle', 'car', 'pickup'];
/** Road depth (cm) at which each way of travelling becomes "ระวัง" / "เลี่ยง" (spec §8.4, D3). */
export const VEHICLE_CM: Record<Vehicle, { caution: number; avoid: number }> = {
  walk: { caution: 10, avoid: 30 },
  motorcycle: { caution: 5, avoid: 10 },
  car: { caution: 10, avoid: 20 },
  pickup: { caution: 20, avoid: 30 },
};
