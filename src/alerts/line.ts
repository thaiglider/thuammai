import { LINE } from '../core/alert-config';
import type { PointState } from '../core/alert-rule';
import { LINE_AUTH_ADMIN_TH, LINE_EXHAUSTED_ADMIN_TH, lineHeldAdminText, lineHeldLine, lineLowAdminText, type HeldReason } from '../core/line-text';
import { coordsReadText, FOLLOW_BUTTON_TH, NOT_A_REPORT_TH, siteLink, tgAlertText } from '../core/tg-text';
import { pointAnswerText } from './answer';
import { lineApi, LOCATION_ACTION, lineRetryKey, textMsg, type LineAction, type LineApi } from './line-api';
import { budgetVerdict, lineDay, lineLimit, lineMonth, lineUsed, quotaLow } from './line-budget';
import type { LineNoticeKind, LineRepo } from './line-repo';
import type { Counts } from './log';
import type { AlertDeps } from './main';
import { toUpdate, type Planned } from './plan';
import type { Snapshot } from './snapshot';
import { tgSender } from './telegram';

/* The LINE side of alerts (phase-3C spec §5.2–§6): free answers every tick, pushes under the budget. */

export interface LineRun { repo: LineRepo; api: LineApi; site: string }

/** LINE is on with a repository, a channel token (absent while LINE_OFF, G-5) and SITE_URL. */
export function lineFor(d: AlertDeps): LineRun | null {
  const token = d.env.LINE_CHANNEL_TOKEN;
  const site = d.env.SITE_URL;
  if (!d.lineRepo || !token || !site) return null;
  return { repo: d.lineRepo, api: lineApi(token, d.fetch, 5_000), site: site.endsWith('/') ? site : `${site}/` };
}

/** Claim → evaluate from the snapshot in memory (the caller re-checked its freshness) → one free
 *  reply each (F2) with [ติดตามจุดนี้] for an approved person with room (R-L3). A claimed question is
 *  deleted whatever LINE answered: its token cannot be used twice. */
export async function answerLineQuestions(d: AlertDeps, snap: Snapshot): Promise<Counts> {
  const line = lineFor(d);
  if (!line) return {};
  const now = d.now();
  const qs = await line.repo.claimPending(now);
  if (!qs.length) return {};
  let use = snap;
  let states: Record<string, PointState> = {};
  if (snap.ok) {
    try {
      states = await d.repo.pointStates([...new Set(qs.map((q) => q.k))]);
    } catch {
      // The tokens are already claimed: answer honestly without levels rather than not at all.
      use = { ...snap, ok: false, reason: 'missing' };
    }
  }
  const month = lineMonth(now);
  const counts: Counts = { line_answer_ok: 0, line_answer_failed: 0 };
  for (const q of qs) {
    let text = pointAnswerText(q, use, new Map(), (k) => states[k], line.site);
    if (q.typed) text = `${coordsReadText(q.lat, q.lon)}\n${text}\n${NOT_A_REPORT_TH}`;
    if (q.heldReason && q.heldMonth === month) text = `${lineHeldLine(q.heldReason)}\n${text}`;
    const canFollow = q.state === 'approved' && !q.follows.includes(q.k) && q.follows.length < LINE.placesPerUser;
    const actions: LineAction[] = canFollow ? [{ type: 'postback', label: FOLLOW_BUTTON_TH, data: `lf:${q.k}`, displayText: FOLLOW_BUTTON_TH }, LOCATION_ACTION] : [LOCATION_ACTION];
    const s = await line.api.reply(q.token, [textMsg(text, actions)]);
    if (s >= 200 && s < 300) counts.line_answer_ok = (counts.line_answer_ok ?? 0) + 1;
    else counts.line_answer_failed = (counts.line_answer_failed ?? 0) + 1;
  }
  await line.repo.done(qs.map((q) => q.id));
  return counts;
}

/** The admin hears about holds, a low quota and 401/403 in Telegram — once per kind per Bangkok day. */
async function notice(d: AlertDeps, line: LineRun, now: Date, kind: LineNoticeKind, text: string): Promise<void> {
  const token = d.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const chat = await line.repo.adminChat();
  if (chat === null) return;
  if (!(await line.repo.noticeOnce(lineMonth(now), kind, lineDay(now)))) return;
  await (d.tgSend ?? tgSender(token, d.fetch))(chat, text);
}

/** A 429 (Change B): at most once per Bangkok day via `noticeOnce`'s own 'exhausted' column — a
 *  'low' notice already sent today (a different column) must not suppress it. `exhausted` can flip
 *  true→false→true within a day as LINE's own consumption figure lags (`saveLineCheck` clears it
 *  early, the next push gets 429 again), so the month-flip in `LineRepo.exhausted` alone is not
 *  enough — the caller only reaches this when that also returned true. */
async function noticeExhausted(d: AlertDeps, line: LineRun, now: Date): Promise<void> {
  await notice(d, line, now, 'exhausted', LINE_EXHAUSTED_ADMIN_TH);
}

/** LINE alerts of one run (spec §5.3, §6): one push per person (≤2 messages = 1 message of quota,
 *  R-L5), each checked against the budget first. Only 2xx/409 is recorded — follows and counters in
 *  one transaction; a held event keeps `alerted` as it was (R-L7). */
export async function sendLine(d: AlertDeps, line: LineRun, items: Planned[], gen: string, deadline: number, clock: () => number): Promise<{ ok: Planned[]; counts: Counts }> {
  const now = d.now();
  const month = lineMonth(now);
  const c: Counts = { line_ok: 0, line_held: 0, line_dead: 0, line_deferred: 0 };
  let stop: 'auth' | 'quota' | null = null;
  const result = (ok: Planned[]): { ok: Planned[]; counts: Counts } => ({ ok, counts: { ...c, ...(stop === 'auth' ? { line_auth: 1 } : {}), ...(stop === 'quota' ? { line_quota: 1 } : {}) } });
  const groups = new Map<string, Planned[]>();
  for (const p of items) {
    const g = groups.get(p.f.lineUser!) ?? [];
    if (g.length >= LINE.placesPerUser) { c.line_deferred++; continue; }
    g.push(p);
    groups.set(p.f.lineUser!, g);
  }
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  // Rule 1: LINE's own numbers, once per run that has LINE work (R-L6).
  const [cons, quota] = await Promise.all([line.api.consumption(), line.api.quota()]);
  if ([cons.status, quota.status].some((s) => s === 401 || s === 403)) {
    stop = 'auth';
    c.line_deferred += total;
    await notice(d, line, now, 'auth', LINE_AUTH_ADMIN_TH);
    return result([]);
  }
  if (cons.status === 200 || quota.status === 200) await line.repo.saveCheck(month, cons.total, quota.limit, now);
  const u = await line.repo.usage(month);
  const limit = lineLimit(u);
  let used = lineUsed(u);
  const sent = await line.repo.userSent(month, [...groups.keys()]);
  const ok: Planned[] = [];
  const held: { user: string; reason: HeldReason }[] = [];
  let heldEvents = 0;
  for (const [user, g] of groups) {
    if (stop !== null || clock() >= deadline || d.stopping?.() === true) { c.line_deferred += g.length; continue; }
    const v = budgetVerdict({ used, limit, exhausted: u.exhausted, level4: g.some((p) => p.kind === 'alert4'), userSent: sent[user] ?? 0 });
    const counted = g.some((p) => p.kind !== 'alert4');
    if (v !== 'send') {
      c.line_held += g.length;
      heldEvents += g.length;
      held.push({ user, reason: v === 'held_user' ? 'user' : v === 'held_exhausted' ? 'exhausted' : 'system' });
      continue;
    }
    const status = await line.api.push(user, g.map((p) => textMsg(tgAlertText(p.f.label ?? 'จุดที่ติดตาม', p.msg!, siteLink(line.site, p.f.key)))), lineRetryKey(user, gen, g.map((p) => ({ fid: p.f.fid, kind: p.kind! }))));
    if ((status >= 200 && status < 300) || status === 409) {
      used++;
      if (counted) sent[user] = (sent[user] ?? 0) + 1;
      c.line_ok += g.length;
      ok.push(...g);
      await line.repo.report({ month, user, follows: g.map(toUpdate), counted });
    } else if (status === 429) {
      stop = 'quota';
      c.line_deferred += g.length;
      // Change B: exhausted(month) (the month-flip) AND noticeOnce (the day gate) — either alone
      // could repeat the admin notice within the same day once LINE's own figure clears `exhausted`.
      if (await line.repo.exhausted(month)) await noticeExhausted(d, line, now);
    } else if (status === 401 || status === 403) {
      stop = 'auth';
      c.line_deferred += g.length;
    } else if (status === 400) {
      c.line_dead += g.length;
      await line.repo.deleteUser(user);
    } else {
      // 5xx or timeout: the next run tries again (same key while the gen is the same). LINE may still
      // have delivered it, so the rest of this run counts it (in memory only, never persisted).
      c.line_deferred += g.length;
      if (status === 0 || status >= 500) used++;
    }
  }
  if (held.length) await line.repo.held(month, held, heldEvents);
  const after = await line.repo.usage(month);
  if (held.length) await notice(d, line, now, 'held', lineHeldAdminText(after.held));
  if (stop === 'auth') await notice(d, line, now, 'auth', LINE_AUTH_ADMIN_TH);
  else if (quotaLow(after)) await notice(d, line, now, 'low', lineLowAdminText(lineUsed(after), lineLimit(after)));
  return result(ok);
}

export const LINE_CHECK_EVERY_MS = 6 * 3600e3;
/** LINE's usage for display and the line_quota_low flag, every 6 hours (spec §6 rule 1). */
export async function refreshLineUsage(d: AlertDeps, now: Date): Promise<Counts> {
  const line = lineFor(d);
  if (!line) return {};
  const month = lineMonth(now);
  const u = await line.repo.usage(month);
  if (u.checkedAt && now.getTime() >= u.checkedAt.getTime() && now.getTime() - u.checkedAt.getTime() < LINE_CHECK_EVERY_MS) return {};
  const [c, q] = await Promise.all([line.api.consumption(), line.api.quota()]);
  if ([c.status, q.status].some((s) => s === 401 || s === 403)) {
    await notice(d, line, now, 'auth', LINE_AUTH_ADMIN_TH);
    return { line_auth: 1 };
  }
  if (c.status !== 200 && q.status !== 200) return { line_check_failed: 1 };
  await line.repo.saveCheck(month, c.total, q.limit, now);
  const after = await line.repo.usage(month);
  if (quotaLow(after)) await notice(d, line, now, 'low', lineLowAdminText(lineUsed(after), lineLimit(after)));
  return { line_checked: 1 };
}
