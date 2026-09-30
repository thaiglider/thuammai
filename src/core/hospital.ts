import { nearest, provincesNear } from './geo';
import type { ProvinceGeo } from './types';
import { HOSPITAL } from './thresholds';

/** One row of data/hospitals/{prov}.json: [osmId ("n123"/"w123"/"r123"), name, lat, lon]. */
export type HospitalItem = readonly [string, string, number, number];
export interface HospitalsFile { generatedAt: string; schema: number; thresholdsVersion: string; fetchedAt: string; items: HospitalItem[] }
export interface NearHospital { osmId: string; name: string; lat: number; lon: number; km: number }

const OSM_TYPE: Record<string, string> = { n: 'node', w: 'way', r: 'relation' };

/** The hospitals within `km` of the point, nearest first (straight-line distance). */
export function nearestHospitals(lat: number, lon: number, items: readonly HospitalItem[], max: number = HOSPITAL.max, km: number = HOSPITAL.nearKm): NearHospital[] {
  const pts = items.map((i) => ({ osmId: i[0], name: i[1], lat: i[2], lon: i[3] }));
  return nearest(pts, lat, lon, km, max).map((x) => ({ ...x.item, km: x.km }));
}

/** Link to the OSM object ("n123" → .../node/123); null for an id we do not recognise. */
export function osmUrl(osmId: string): string | null {
  const type = OSM_TYPE[osmId.slice(0, 1)];
  const id = osmId.slice(1);
  return type && /^\d+$/.test(id) ? `https://www.openstreetmap.org/${type}/${id}` : null;
}

/** Provinces whose hospital files can hold a hospital within the search radius of the point
 *  (a wider net than the 10 km used for stations: the radius here is HOSPITAL.nearKm). */
export const hospitalProvinces = (lat: number, lon: number, provinces: readonly ProvinceGeo[]): string[] =>
  provincesNear(lat, lon, provinces, HOSPITAL.nearKm);
