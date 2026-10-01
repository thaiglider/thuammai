import { accessAt, areaAround, type Access, type Area } from './access';
import { accessLabel, accessLine, actionLines, areaLine, causeLines, confidenceLine, headlineText, NO_OFFICIAL_ORDER, situationText, trendLine, vehicleLine } from './advice';
import { CLEAR_TITLE_TH, clearLead, HELD_TH, TREND_TITLE_TH, trendLead } from './alert-text';
import { LEVEL_TH } from './labels';
import { reasonLine } from './reason-text';
import type { Assessment, RiskInput } from './risk';
import { groupOf, situationOf, type Situation } from './situation';
import { fmtTime } from './time';
import { pointTrend, trendCandidates, type Trend } from './trend';
import type { TrendKind } from './trend-alert';
import type { Level } from './types';

/** Telegram allows 4096; the rest is headroom (Plan O spec §2.2). */
export const TG_DETAIL_MAX = 3500;
/** Telegram rejects a text longer than this. */
export const TG_TEXT_MAX = 4096;
export const NO_DATA_POINT_TH = 'ไม่มีข้อมูลพอประเมินจุดนี้ — ไม่ได้แปลว่าปลอดภัย';
export const NO_REASON_TH = 'ไม่มีสถานีหรือรายงานที่ใกล้พอจะใช้ประเมินจุดนี้';
export const EMERGENCY_LINE_TH = 'ฉุกเฉิน: โทร 1784 · 1669';

/** What the message is (spec §2.3): decides the title and the lead lines. */
export type CardHead =
  | { kind: 'alert'; label: string; joined: boolean }
  | { kind: 'clear'; label: string; quietUntil: string | null }
  | { kind: TrendKind; label: string }
  | { kind: 'view'; label: string }
  | { kind: 'answer' };

/** The card's inputs for one point (the web computes the same in views/home.ts). */
export interface CardFacts { shown: Level; a: Assessment; trend: Trend; situation: Situation; access: Access; area: Area; causes: string[]; now: Date }

export function cardFacts(lat: number, lon: number, input: RiskInput, a: Assessment, shown: Level): CardFacts {
  const trend = pointTrend(a, input.obs, input.now);
  return { shown, a, trend, situation: situationOf(shown, a, trend, input.obs, input.now), access: accessAt(lat, lon, input, 'near'), area: areaAround(lat, lon, input), causes: causeLines(a, input.obs), now: input.now };
}

/** The station of the card's first chart: the first deciding water station, or none. */
export function chartStation(a: Assessment): { id: string; km: number } | null {
  const r = trendCandidates(a)[0];
  return r ? { id: r.stationId!, km: r.km } : null;
}

const bullets = (xs: readonly string[]): string[] => xs.map((x) => `• ${x}`);

function titleOf(h: CardHead, shown: Level): string {
  switch (h.kind) {
    case 'answer': return `ระดับของจุดที่คุณส่งมา: ${LEVEL_TH[shown]}`;
    case 'clear': return `${h.label}: ${CLEAR_TITLE_TH}`;
    case 'alert': case 'view': return `${h.label}: ${LEVEL_TH[shown]}`;
    default: return `${h.label}: ${TREND_TITLE_TH[h.kind]}`;
  }
}
function leadOf(h: CardHead, shown: Level): string[] {
  switch (h.kind) {
    case 'alert': return h.joined ? [`ตอนนี้จุดนี้อยู่ในระดับ${LEVEL_TH[shown]}`] : [];
    case 'clear': return clearLead(shown, h.quietUntil);
    case 'answer': case 'view': return [];
    default: return trendLead(h.kind, shown);
  }
}

/** The card as plain text (spec §2.2): groups separated by a blank line. Over TG_DETAIL_MAX the
 *  reasons go first, then the causes, then the vehicle line — never the level, the actions, the
 *  emergency numbers, the time or the link. */
export function tgCardText(h: CardHead, f: CardFacts, gen: string, link: string): string {
  const { shown, a } = f;
  const head = [titleOf(h, shown), ...leadOf(h, shown)];
  const foot = [`ข้อมูลเมื่อ ${fmtTime(gen)} · ${NO_OFFICIAL_ORDER}`, `ดูรายละเอียด: ${link}`];
  const join = (groups: string[][]) => groups.filter((g) => g.length).map((g) => g.join('\n')).join('\n\n');
  if (shown === 0) return join([[...head, NO_DATA_POINT_TH], foot]);
  const at = { ...a, level: shown };
  const tl = trendLine(f.trend);
  const conf = confidenceLine(at);
  // "เลิกเตือน" has no situation headline: "น้ำลดต่ำกว่าระดับเตือนแล้ว" would contradict its own lead.
  const status = [
    ...(h.kind === 'clear' ? [] : [situationText(f.situation, f.trend) ?? headlineText(at)]),
    ...(a.level < shown ? [HELD_TH] : []),
    ...(tl ? [tl] : []),
    ...(conf ? [conf] : []),
  ];
  const facets = [`จุดนี้: ${LEVEL_TH[shown]}`, `${accessLabel(f.access.at)}: ${accessLine(f.access)}`, `ย่าน 3 กม.: ${areaLine(f.area)}`];
  const vehicle = vehicleLine(a.vehicleDepthCm);
  const group = groupOf(f.situation);
  const causes = (group === 'approach' || group === 'flooded') && f.causes.length ? ['ทำไมน้ำยังขึ้น:', ...bullets(f.causes)] : [];
  const acts = actionLines(shown, f.situation);
  const actions = [
    ...(acts.length ? ['ควรทำ:', ...bullets(acts)] : []),
    ...(shown === 4 && !acts.some((x) => x.includes('1784')) ? [EMERGENCY_LINE_TH] : []),
  ];
  const reasons = ['เหตุผล:', ...(a.reasons.length ? bullets(a.reasons.slice(0, 3).map((r) => reasonLine(r, f.now))) : [NO_REASON_TH])];
  const build = (o: { reasons: boolean; causes: boolean; vehicle: boolean }) =>
    join([head, status, [...facets, ...(o.vehicle && vehicle ? [`🚗 ${vehicle}`] : [])], o.causes ? causes : [], actions, o.reasons ? reasons : [], foot]);
  for (const o of [{ reasons: true, causes: true, vehicle: true }, { reasons: false, causes: true, vehicle: true }, { reasons: false, causes: false, vehicle: true }]) {
    const t = build(o);
    if (t.length <= TG_DETAIL_MAX) return t;
  }
  return build({ reasons: false, causes: false, vehicle: false });
}
