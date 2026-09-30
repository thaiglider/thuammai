import { RELAY_PROBLEM_MIN } from '../core/thresholds';
import { RELAY_PROBLEM_TH, RELAY_RECOVERED_TH, relayProblem, staleOwnerText, staleRecoveredText, staleWaterSources, watchKeyRecovered, type WaterSourceId } from '../core/source-watch';
import type { SourceHealth } from '../core/types';
import { lineDay } from './line-budget';
import type { Counts } from './log';
import { tgSender, type TgSend } from './telegram';

/* The owner hears in Telegram (the admin chat of the LINE notices) when a water source goes stale
 * or the BMA relay fails (owner-approved 2026-09-30, lessons-learned §K). Evaluated once per new
 * snapshot gen by runAlerts; never blocks or fails the run (the caller swallows errors). */

/** One problem being watched: first seen `since`, last told `notifiedDay` (Bangkok day).
 *  `recoveredAt` set = cleared (recovery notice sent) but kept for the rest of that Bangkok day, so
 *  a flap back to stale the same day is not told twice. */
export interface WatchRow { key: string; since: Date; notifiedDay: string | null; recoveredAt: Date | null }
export interface SourceWatchRepo {
  list(): Promise<WatchRow[]>;
  upsert(row: WatchRow): Promise<void>;
  remove(key: string): Promise<void>;
  adminChat(): Promise<number | null>;
}
export interface WatchDeps {
  watchRepo?: SourceWatchRepo;
  env: { TELEGRAM_BOT_TOKEN?: string; SOURCE_WATCH?: string };
  fetch: typeof fetch; tgSend?: TgSend;
}

/** On unless SOURCE_WATCH is exactly '0'. */
export const sourceWatchOn = (e: { SOURCE_WATCH?: string }): boolean => e.SOURCE_WATCH !== '0';

interface Problem { key: string; text: string; minMs: number }
const staleKey = (id: WaterSourceId) => `stale:${id}`;
const RECOVERED: Record<string, string> = {
  relay: RELAY_RECOVERED_TH,
  ...Object.fromEntries((['river', 'canal', 'road', 'rain'] as const).map((id) => [staleKey(id), staleRecoveredText(id)])),
};

/** Track, notify (≤1 per key per Bangkok day, flaps included; the relay only after
 *  RELAY_PROBLEM_MIN) and send one recovery notice when a notified key positively clears
 *  (watchKeyRecovered — with hysteresis; a source that merely left the stale set by getting worse
 *  stays watched, silently). No admin chat or no bot token: tracked only.
 *  Returns `stale=<n>` (+ watch_sent / watch_send_failed). Throws on a store failure. */
export async function watchSources(d: WatchDeps, sources: readonly SourceHealth[] | undefined, now: Date): Promise<Counts> {
  const stale = staleWaterSources(sources, now);
  const counts: Counts = { stale: stale.length };
  if (!d.watchRepo || !sourceWatchOn(d.env) || !Array.isArray(sources)) return counts;
  const repo = d.watchRepo;
  const problems: Problem[] = stale.map((s) => ({ key: staleKey(s.id), text: staleOwnerText(s), minMs: 0 }));
  if (relayProblem(sources)) problems.push({ key: 'relay', text: RELAY_PROBLEM_TH, minMs: RELAY_PROBLEM_MIN * 60e3 });
  const day = lineDay(now);
  const rows = new Map<string, WatchRow>();
  for (const r of await repo.list()) {
    // Housekeeping: a recovered row only lives out the Bangkok day it was told on.
    if (r.recoveredAt !== null && r.notifiedDay !== day) await repo.remove(r.key);
    else rows.set(r.key, r);
  }
  const token = d.env.TELEGRAM_BOT_TOKEN;
  let chat: number | null | undefined;
  const send = async (text: string): Promise<boolean> => {
    if (!token) return false;
    if (chat === undefined) chat = await repo.adminChat();
    if (chat === null) return false;
    const r = await (d.tgSend ?? tgSender(token, d.fetch))(chat, text);
    if (r.ok) counts.watch_sent = (counts.watch_sent ?? 0) + 1;
    else counts.watch_send_failed = (counts.watch_send_failed ?? 0) + 1;
    return r.ok;
  };
  for (const p of problems) {
    const old = rows.get(p.key);
    // Back again the day it recovered (housekeeping kept only today's): already alerted and told
    // "recovered" today — stay silent until tomorrow, so a flapping feed is one ⚠️ + one ✅ a day.
    if (old?.recoveredAt != null) continue;
    const changed = old === undefined;
    const row: WatchRow = old ?? { key: p.key, since: now, notifiedDay: null, recoveredAt: null };
    if (now.getTime() - row.since.getTime() >= p.minMs && row.notifiedDay !== day && (await send(p.text))) {
      row.notifiedDay = day;
      await repo.upsert(row);
    } else if (changed) await repo.upsert(row);
  }
  const current = new Set(problems.map((p) => p.key));
  for (const row of rows.values()) {
    if (current.has(row.key) || row.recoveredAt !== null) continue;
    // Never alerted (the relay's 60-min wait): the episode ended — forget it, so a later failure
    // starts a fresh 60-min wait instead of alerting at once.
    if (row.notifiedDay === null) { await repo.remove(row.key); continue; }
    // Not a problem now, but not positively recovered either (gone, no items, no time, 5–6 h):
    // keep watching, say nothing.
    if (!watchKeyRecovered(row.key, sources, now)) continue;
    // Told about it: one recovery notice (at most once — whatever Telegram said).
    await send(RECOVERED[row.key] ?? `✅ ${row.key} กลับมาปกติแล้ว`);
    if (row.notifiedDay === day) await repo.upsert({ ...row, recoveredAt: now });
    else await repo.remove(row.key);
  }
  return counts;
}
