import type { HeldReason, LineState } from '../core/line-text';
import type { LineUsage } from './line-budget';
import type { FollowUpdate } from './repo';

/* Where the LINE side of alerts reads and writes (phase-3C spec §5.2–§6). Driver-free, like repo.ts. */

/** A claimed question: the reply token is ours to use once (F4). */
export interface LinePendingRow {
  id: number; user: string; k: string; lat: number; lon: number; typed: boolean; token: string;
  /** null: the person never asked for alerts (anyone may ask for a level, R-L3). */
  state: LineState | null;
  /** Keys this person follows now. */
  follows: string[];
  heldMonth: string | null; heldReason: HeldReason | null;
}

export type LineNoticeKind = 'held' | 'low' | 'auth';
/** One successful push: the follows' new state + the counters, in one transaction (spec §6 rule 4). */
/** `counted`: the push held at least one non-level-4 message, so it counts against the person's 10
 *  (spec §6: "ไม่รวมระดับ 4"); the month total always counts. */
export interface LineReport { month: string; user: string; follows: FollowUpdate[]; counted: boolean }

export interface LineRepo {
  /** Deletes questions older than LINE.pendingDropS, then claims (atomically, `claimed_at IS NULL`,
   *  and no older than LINE.pendingMaxAgeS — the api fallback owns rows in between) at most
   *  LINE.answersPerTick fresh ones, oldest first. */
  claimPending(now: Date): Promise<LinePendingRow[]>;
  /** Answered (or failed) questions are deleted. */
  done(ids: number[]): Promise<void>;
  usage(month: string): Promise<LineUsage>;
  saveCheck(month: string, total: number | null, limit: number | null, at: Date): Promise<void>;
  /** This month's push count per user, for those given (missing keys: 0). */
  userSent(month: string, users: string[]): Promise<Record<string, number>>;
  /** A successful push: the follows it changed + the month/person counters, in one transaction, and
   *  clears any held mark on the person. */
  report(r: LineReport): Promise<void>;
  /** People held by the budget this run (R-L7) and the number of held events (G-8). */
  held(month: string, people: { user: string; reason: HeldReason }[], events: number): Promise<void>;
  /** A 429 this run: marks the month exhausted. True only the first time this month flips (the
   *  caller uses that to tell the admin at most once per month — controller ruling 3). */
  exhausted(month: string): Promise<boolean>;
  deleteUser(user: string): Promise<void>;
  /** true the first time per kind and Bangkok day. */
  noticeOnce(month: string, kind: LineNoticeKind, day: string): Promise<boolean>;
  adminChat(): Promise<number | null>;
}
