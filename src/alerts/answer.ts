import type { PointState } from '../core/alert-rule';
import { alertShown } from '../core/hysteresis';
import { assessPoint } from '../core/risk';
import { pointReplyText, siteLink } from '../core/tg-text';
import type { Level } from '../core/types';
import type { PointEval } from './plan';
import { inputAt, type Snapshot } from './snapshot';

export type Stored = (key: string) => PointState | undefined;

/** The point's level as the card would show it (E10): this run's hysteresis for an evaluated place,
 *  else the stored one, else the raw level. The same answer for Telegram and LINE (spec §5.2). */
export function pointAnswerText(q: { k: string; lat: number; lon: number }, snap: Snapshot, points: Map<string, PointEval>, stored: Stored, site: string): string {
  const link = siteLink(site, q.k);
  if (!snap.ok) return pointReplyText({ unusable: true, gen: snap.gen || null }, link);
  const a = assessPoint(q.lat, q.lon, inputAt(snap, q.lat, q.lon));
  const st = stored(q.k);
  const shownNow = points.get(q.k)?.step.shown ?? (st ? alertShown(st, a.level, snap.gen).shown : null);
  const shown: Level = shownNow === 3 || shownNow === 4 ? shownNow : a.level;
  return pointReplyText({ shown, a, gen: snap.gen }, link);
}
