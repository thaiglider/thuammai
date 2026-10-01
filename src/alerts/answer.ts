import { parseAlertKey } from '../core/alert-key';
import type { PointState } from '../core/alert-rule';
import { alertShown } from '../core/hysteresis';
import { assessPoint, type Assessment } from '../core/risk';
import { cardFacts, chartStation, tgCardText, type CardHead } from '../core/tg-card';
import { cardButtons, FOLLOW_FALLBACK_LABEL_TH, pointReplyText, siteLink, type TgInlineMarkup } from '../core/tg-text';
import type { Level } from '../core/types';
import { isTrendKind, type Planned, type PointEval } from './plan';
import type { PendingRow } from './repo';
import { inputAt, type Snapshot } from './snapshot';

export type Stored = (key: string) => PointState | undefined;

/** The point's level as the card would show it (E10): this run's hysteresis for an evaluated place,
 *  else the stored one, else the raw level. */
function shownLevel(k: string, a: Assessment, snap: Snapshot, points: Map<string, PointEval>, stored: Stored): Level {
  const st = stored(k);
  const shownNow = points.get(k)?.step.shown ?? (st ? alertShown(st, a.level, snap.gen).shown : null);
  return shownNow === 3 || shownNow === 4 ? shownNow : a.level;
}

/** The short answer — LINE's (spec §5.2 of phase 3C); Telegram uses pendingOut. */
export function pointAnswerText(q: { k: string; lat: number; lon: number }, snap: Snapshot, points: Map<string, PointEval>, stored: Stored, site: string): string {
  const link = siteLink(site, q.k);
  if (!snap.ok) return pointReplyText({ unusable: true, gen: snap.gen || null }, link);
  const a = assessPoint(q.lat, q.lon, inputAt(snap, q.lat, q.lon));
  return pointReplyText({ shown: shownLevel(q.k, a, snap, points, stored), a, gen: snap.gen }, link);
}

/** One Telegram message (Plan O spec §2): the detail text, its buttons, and the station whose
 *  7-day chart follows it (null = no photo). */
export interface TgOut { text: string; markup: TgInlineMarkup | undefined; chart: { id: string; km: number } | null }

/** The answer to a queued question: a "ดู" request (q.fid) is titled with the follow's name. */
export function pendingOut(q: PendingRow, snap: Snapshot, points: Map<string, PointEval>, stored: Stored, site: string): TgOut {
  const link = siteLink(site, q.k);
  const markup = cardButtons(q.fid, link);
  if (!snap.ok) return { text: pointReplyText({ unusable: true, gen: snap.gen || null }, link), markup, chart: null };
  const input = inputAt(snap, q.lat, q.lon);
  const a = assessPoint(q.lat, q.lon, input);
  const shown = shownLevel(q.k, a, snap, points, stored);
  const head: CardHead = q.fid !== null ? { kind: 'view', label: q.label ?? FOLLOW_FALLBACK_LABEL_TH } : { kind: 'answer' };
  return { text: tgCardText(head, cardFacts(q.lat, q.lon, input, a, shown), snap.gen, link), markup, chart: shown === 0 ? null : chartStation(a) };
}

/** An alert, a clear or a trend note for one follower; null when it cannot be built (the caller
 *  then falls back to the short text — an alert is never lost to its details). */
export function alertOut(p: Planned, e: PointEval | undefined, snap: Snapshot, site: string): TgOut | null {
  const at = parseAlertKey(p.f.key);
  if (!at || !e?.a || !p.kind || !snap.ok) return null;
  const a = e.a;
  const link = siteLink(site, p.f.key);
  const label = p.f.label ?? FOLLOW_FALLBACK_LABEL_TH;
  const stepShown: Level = e.step.shown === 3 || e.step.shown === 4 ? e.step.shown : a.level;
  const head: CardHead = p.kind === 'clear' ? { kind: 'clear', label, quietUntil: p.quietUntil ?? null }
    : isTrendKind(p.kind) ? { kind: p.kind, label }
      : { kind: 'alert', label, joined: e.joined };
  const shown: Level = p.kind === 'clear' ? a.level : stepShown;
  return { text: tgCardText(head, cardFacts(at.lat, at.lon, inputAt(snap, at.lat, at.lon), a, shown), snap.gen, link), markup: cardButtons(p.f.fid, link), chart: chartStation(a) };
}
