export type GazRow = [string, string, number, number];
export interface GazHit { code: string; name: string; label: string; lat: number; lon: number; level: 1 | 2 | 3; score: number }
export interface GazIndex { rows: GazRow[]; norm: string[]; names: Map<string, string> }

const PREFIX = /^(จังหวัด|จ\.|อำเภอ|อ\.|เขต|ตำบล|ต\.|แขวง|กิ่งอำเภอ)\s*/;
const TONES = /[่-๋]/g;

export function normalizeThai(s: string): string {
  let t = s.trim().toLowerCase();
  let prev = '';
  while (prev !== t) { prev = t; t = t.replace(PREFIX, ''); }
  return t.replace(/\s+/g, '').replace(TONES, '');
}

export function buildIndex(rows: GazRow[]): GazIndex {
  return { rows, norm: rows.map((r) => normalizeThai(r[1])), names: new Map(rows.map((r) => [r[0], r[1]])) };
}

function label(idx: GazIndex, code: string, name: string): string {
  const bkk = code.startsWith('10');
  const prov = idx.names.get(code.slice(0, 2)) ?? '';
  if (code.length === 2) return bkk ? name : `จ.${name}`;
  if (code.length === 4) return bkk ? `เขต${name} ${prov}` : `อ.${name} จ.${prov}`;
  const amphoe = idx.names.get(code.slice(0, 4)) ?? '';
  return bkk ? `แขวง${name} เขต${amphoe} ${prov}` : `ต.${name} อ.${amphoe} จ.${prov}`;
}

// Common short names that are not substrings of the official name.
const ALIAS: Record<string, string> = Object.fromEntries(
  ['กทม', 'กทม.', 'กรุงเทพ', 'กรุงเทพฯ', 'กรุงเทพ ฯ'].map((k) => [normalizeThai(k), normalizeThai('กรุงเทพมหานคร')]),
);

export function search(idx: GazIndex, query: string, limit = 8): GazHit[] {
  const n0 = normalizeThai(query);
  const q = ALIAS[n0] ?? n0;
  if (q.length < 2) return [];
  const hits: GazHit[] = [];
  idx.rows.forEach((r, i) => {
    const n = idx.norm[i]!;
    let score: number;
    if (n === q) score = 100;
    else if (n.startsWith(q)) score = 80;
    else if (n.includes(q)) score = 50;
    else return;
    const level = (r[0].length / 2) as 1 | 2 | 3;
    hits.push({ code: r[0], name: r[1], label: label(idx, r[0], r[1]), lat: r[2], lon: r[3], level, score: score + (4 - level) * 0.1 - n.length * 0.001 });
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
