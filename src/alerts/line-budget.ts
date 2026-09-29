import { LINE } from '../core/alert-config';

/* The LINE monthly budget (phase-3C spec §6, R-L4–R-L6). Pure: the api (welcome push) and alerts
 * (alert pushes) decide with the same rule. */

const BKK_MS = 7 * 3600e3;
/** The Asia/Bangkok calendar month, "YYYY-MM". */
export const lineMonth = (d: Date): string => new Date(d.getTime() + BKK_MS).toISOString().slice(0, 7);
/** The Asia/Bangkok day, "YYYY-MM-DD" (admin notices: once per day). */
export const lineDay = (d: Date): string => new Date(d.getTime() + BKK_MS).toISOString().slice(0, 10);
/** "YYYY-MM" n months earlier. */
export function monthMinus(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const i = y * 12 + (m - 1) - n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

export interface LineUsage { sent: number; held: number; lineTotal: number | null; lineLimit: number | null; checkedAt: Date | null; exhausted: boolean }
export const EMPTY_USAGE: LineUsage = { sent: 0, held: 0, lineTotal: null, lineLimit: null, checkedAt: null, exhausted: false };

/** min(300, the value GET quota reported) — never above the free plan. */
export const lineLimit = (u: Pick<LineUsage, 'lineLimit'>): number => Math.min(LINE.monthlyLimit, u.lineLimit ?? LINE.monthlyLimit);
/** max(our count, LINE's totalUsage) (R-L6): early in a month LINE may still report last month — too careful, never over. */
export const lineUsed = (u: Pick<LineUsage, 'sent' | 'lineTotal'>): number => Math.max(u.sent, u.lineTotal ?? 0);

/** held_exhausted: nothing more goes this month (a 429, or the whole limit used) — not even level 4.
 *  held_system: only the reserve is left, which level 4 may still use. */
export type BudgetVerdict = 'send' | 'held_user' | 'held_system' | 'held_exhausted';
/** Spec §6 rule 2. `level4`: a new level 4 or 3→4 (and the welcome message) — uses the reserve. */
export function budgetVerdict(o: { used: number; limit: number; exhausted: boolean; level4: boolean; userSent: number }): BudgetVerdict {
  if (o.exhausted || o.used >= o.limit) return 'held_exhausted';
  if (o.level4) return 'send';
  if (o.used >= o.limit - LINE.reserve) return 'held_system';
  return o.userSent < LINE.perUserMonth ? 'send' : 'held_user';
}
/** At most `reserve` left (health flag line_quota_low, admin notice). */
export const quotaLow = (u: LineUsage): boolean => lineLimit(u) - lineUsed(u) <= LINE.reserve;
