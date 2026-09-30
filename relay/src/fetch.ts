const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30_000;
const DIRECTUS = 'https://floodbangkok.bangkok.go.th/api/flood/items/sensor_flood';
const CANAL_URL = 'https://weather.bangkok.go.th/water/PageMap/GoogleMap';
const FIELDS = [
  'sensor_name', 'value', 'timestamp', 'door', 'check_flood',
  'sensor_profile_id.code', 'sensor_profile_id.name', 'sensor_profile_id.road', 'sensor_profile_id.district',
  'sensor_profile_id.lat', 'sensor_profile_id.long', 'sensor_profile_id.device_status',
].join(',');

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new Error(`not json (${ct.split(';')[0] || 'no content-type'})`);
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new Error('invalid json');
  }
}

/** Directus sensor_flood, newest first, created within the last `windowMin` minutes. */
export async function fetchRoad(now: Date, windowMin = 15): Promise<unknown> {
  const from = new Date(now.getTime() - windowMin * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const q = `limit=-1&sort=-date_created&filter[date_created][_gte]=${encodeURIComponent(from)}&fields=${FIELDS}`;
  const j = (await getJson(`${DIRECTUS}?${q}`, { headers: { 'user-agent': UA, accept: 'application/json' } })) as { data?: unknown };
  if (!j || !Array.isArray(j.data)) throw new Error('unexpected road shape');
  return j.data;
}

export async function fetchCanal(): Promise<unknown> {
  const j = await getJson(CANAL_URL, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://weather.bangkok.go.th/water',
      origin: 'https://weather.bangkok.go.th',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: 'payload=',
  });
  if (!Array.isArray(j)) throw new Error('unexpected canal shape');
  return j;
}
