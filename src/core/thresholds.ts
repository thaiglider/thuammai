export const THRESHOLDS_VERSION = '2026-09-28.4';

/** กทม. นนทบุรี ปทุมธานี สมุทรปราการ นครปฐม สมุทรสาคร — rules use the STATION's province. */
export const BKK_METRO: readonly string[] = ['10', '11', '12', '13', '73', '74'];

/** Freshness limit in minutes per kind; older = stale; older than ×DROP_FACTOR = not published. */
export const FRESH_MIN = { river: 180, rain: 180, road: 120, canal: 120, dam: 2880 } as const;
export const DROP_FACTOR = 4;
export const FUTURE_TOLERANCE_MIN = 10;

/** Thailand bounding box for coordinate sanity checks [minLon, minLat, maxLon, maxLat]. */
export const TH_BBOX = [97.3, 5.6, 105.7, 20.5] as const;

export const RIVER = { fb4: 0, fb3: 0.2, fb2: 0.5, outOfRangeAboveBank: 3 } as const;
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
export const AREA = { minShare: 0.15 } as const;

/** Minimum item counts below which a successful fetch is treated as a failure (outage masked as empty). */
export const MIN_COUNT = { river: 300, rain: 1000, road: 100, canal: 100, dam: 20, longdo: 0, traffy: 0, forecast: 1, tmd: 0 } as const;

/** Rendering-layer display cutoffs (never used by risk rules). */
export const DISPLAY = { slopeTextMinMH: 0.02, nearestWaterMaxKm: 20 } as const;
