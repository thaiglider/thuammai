/** Compact BMA payload the Thai relay POSTs to flood-api; the pipeline reads it back (Plan M, spec §2). */
export interface RelayRoad {
  code: string; // sensor_name, e.g. "FL.YNW.03" or "TN.SLG.02(OUT)" -> road:<code>
  name: string; // Thai name, trailing "*" removed
  lat: number;
  lon: number;
  district?: string;
  t: string; // YYYY-MM-DDTHH:mm:ss+07:00
  cm: number;
}

export interface RelayCanal {
  code: string; // water_code, e.g. "WL.PKG.01" -> canal:<code>
  name: string;
  lat: number;
  lon: number;
  t: string;
  level: number; // metres
  bankL: number | null;
  bankR: number | null;
  warn: number | null;
  crit: number | null;
}

export interface RelayPayload {
  v: 1;
  fetchedAt: string; // YYYY-MM-DDTHH:mm:ss+07:00
  road: RelayRoad[];
  canal: RelayCanal[];
  error?: string;
}
