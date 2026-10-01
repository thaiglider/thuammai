import { RepoError, type AlertRepo, type FollowRow, type FollowUpdate, type PendingRow, type PlaceRow, type Report } from '../../../src/alerts/repo';
import { CAPS } from '../../../src/core/alert-config';
import { parseAlertKey } from '../../../src/core/alert-key';
import type { PointState } from '../../../src/core/alert-rule';
import type { TrendFollow, TrendRun } from '../../../src/core/trend-alert';
import { toIso07 } from '../../../src/core/time';
import type { Db } from '../db/db';

const KEYS_PER_QUERY = 1000;
const STATE_CHUNK = 5000;

/** timestamptz → the ISO string src/core expects: "+07:00" for whole seconds (every snapshot time
 *  is one), the full UTC form when milliseconds are present (never lose precision). */
export const isoOut = (d: Date): string => (d.getTime() % 1000 === 0 ? toIso07(d) : d.toISOString());
const isoOrNull = (d: Date | null): string | null => (d === null ? null : isoOut(d));
const ms = (s: string | undefined): number | null => (s === undefined ? null : Date.parse(s));
const same = (a: PointState | undefined, b: PointState): boolean =>
  a !== undefined && ms(a.l3) === ms(b.l3) && ms(a.l4) === ms(b.l4) && ms(a.below) === ms(b.below) && !!a.ep === !!b.ep
  && (a.tr ?? null) === (b.tr ?? null) && ms(a.trSince) === ms(b.trSince);
const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

interface StateRow { key: string; l3: Date | null; l4: Date | null; below: Date | null; ep: boolean; tr: TrendRun | null; tr_since: Date | null }
function toPoint(r: StateRow): PointState {
  const p: PointState = {};
  if (r.l3) p.l3 = isoOut(r.l3);
  if (r.l4) p.l4 = isoOut(r.l4);
  if (r.below) p.below = isoOut(r.below);
  if (r.ep) p.ep = 1;
  // Both or neither: a half-written pair (never written by this code) counts as no trend run.
  if (r.tr && r.tr_since) { p.tr = r.tr; p.trSince = isoOut(r.tr_since); }
  return p;
}
interface FollowDbRow {
  fid: number; targetId: number; key: string; ch: 'push' | 'tg' | 'line'; label: string | null; endpoint: string | null; p256dh: string | null; auth: string | null;
  chat: number | null; lineUser: string | null; alerted: number; lastAlertAt: Date | null; lastL4At: Date | null; lastClearAt: Date | null;
  trendNote: TrendFollow['trendNote']; trendAt: Date | null;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new RepoError();
  }
}

/** The follow half of `report` (spec §6.2): the one home of this UPDATE, so LINE's `report`
 *  (server/src/alerts/line-repo-pg.ts) calls this instead of repeating it (controller ruling). */
export async function writeFollows(t: Db, follows: FollowUpdate[]): Promise<void> {
  if (!follows.length) return;
  await t.query(
    'UPDATE follow AS f SET alerted = u.alerted, last_alert_at = u.a, last_l4_at = u.l4, last_clear_at = u.c, trend_note = u.tn, trend_at = u.ta FROM unnest($1::bigint[], $2::smallint[], $3::timestamptz[], $4::timestamptz[], $5::timestamptz[], $6::text[], $7::timestamptz[]) AS u(fid, alerted, a, l4, c, tn, ta) WHERE f.id = u.fid',
    [follows.map((f) => f.fid), follows.map((f) => f.alerted), follows.map((f) => f.lastAlertAt), follows.map((f) => f.lastL4At), follows.map((f) => f.lastClearAt), follows.map((f) => f.trendNote), follows.map((f) => f.trendAt)],
  );
}

export function pgRepo(db: Db): AlertRepo {
  return {
    places: () => guard(async () => (await db.query<PlaceRow>('SELECT key AS k, lat, lon FROM place ORDER BY key')).rows),

    loadState: () => guard(async () => {
      const run = (await db.query<{ gen: Date | null }>('SELECT gen FROM alert_run WHERE id = 1')).rows[0];
      if (!run?.gen) return null;
      const rs = (await db.query<StateRow>('SELECT key, l3, l4, below, ep, tr, tr_since FROM point_state')).rows;
      return { v: 1, gen: isoOut(run.gen), places: Object.fromEntries(rs.map((r) => [r.key, toPoint(r)])) };
    }),

    saveState: (prev, next) => guard(() => db.tx(async (t) => {
      const moved = await t.query('UPDATE alert_run SET gen = $1 WHERE id = 1 AND (gen IS NULL OR gen <= $1) RETURNING id', [next.gen]);
      if (moved.rowCount === 0) return 'older' as const;
      const before = prev?.places ?? {};
      const changed = Object.entries(next.places).filter(([k, p]) => !same(before[k], p));
      for (const c of chunks(changed, STATE_CHUNK)) {
        await t.query(
          'INSERT INTO point_state (key, l3, l4, below, ep, tr, tr_since, updated_at) SELECT u.key, u.l3, u.l4, u.below, u.ep, u.tr, u.ts, now() FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[], $4::timestamptz[], $5::boolean[], $6::text[], $7::timestamptz[]) AS u(key, l3, l4, below, ep, tr, ts) ON CONFLICT (key) DO UPDATE SET l3 = excluded.l3, l4 = excluded.l4, below = excluded.below, ep = excluded.ep, tr = excluded.tr, tr_since = excluded.tr_since, updated_at = excluded.updated_at',
          [c.map(([k]) => k), c.map(([, p]) => p.l3 ?? null), c.map(([, p]) => p.l4 ?? null), c.map(([, p]) => p.below ?? null), c.map(([, p]) => p.ep === 1), c.map(([, p]) => (p.tr && p.trSince ? p.tr : null)), c.map(([, p]) => (p.tr && p.trSince ? p.trSince : null))],
        );
      }
      const gone = Object.keys(before).filter((k) => !(k in next.places));
      for (const c of chunks(gone, STATE_CHUNK)) await t.query('DELETE FROM point_state WHERE key = ANY($1::text[])', [c]);
      return 'ok' as const;
    })),

    pointStates: (keys) => guard(async () => {
      if (!keys.length) return {};
      const rs = (await db.query<StateRow>('SELECT key, l3, l4, below, ep, tr, tr_since FROM point_state WHERE key = ANY($1::text[])', [keys])).rows;
      return Object.fromEntries(rs.map((r) => [r.key, toPoint(r)]));
    }),

    targets: (keys) => guard(async () => {
      const out: FollowRow[] = [];
      for (const c of chunks(keys, KEYS_PER_QUERY)) {
        const rs = await db.query<FollowDbRow>(
          'SELECT f.id AS fid, t.id AS "targetId", f.key AS key, t.channel AS ch, f.label AS label, t.endpoint AS endpoint, t.p256dh AS p256dh, t.auth AS auth, t.chat_id AS chat, t.line_user AS "lineUser", f.alerted AS alerted, f.last_alert_at AS "lastAlertAt", f.last_l4_at AS "lastL4At", f.last_clear_at AS "lastClearAt", f.trend_note AS "trendNote", f.trend_at AS "trendAt" FROM follow f JOIN target t ON t.id = f.target_id WHERE f.key = ANY($1::text[]) ORDER BY f.id',
          [c],
        );
        for (const r of rs.rows) {
          out.push({ ...r, alerted: r.alerted as 0 | 3 | 4, lastAlertAt: isoOrNull(r.lastAlertAt), lastL4At: isoOrNull(r.lastL4At), lastClearAt: isoOrNull(r.lastClearAt), trendNote: r.trendNote ?? null, trendAt: isoOrNull(r.trendAt) });
        }
      }
      return out;
    }),

    report: (r: Report) => guard(() => db.tx(async (t) => {
      await writeFollows(t, r.follows);
      if (r.deadTargets.length) await t.query('DELETE FROM target WHERE id = ANY($1::bigint[])', [r.deadTargets]);
      if (r.donePending.length) await t.query('DELETE FROM tg_pending WHERE id = ANY($1::bigint[])', [r.donePending]);
    })),

    tgPending: (now) => guard(async () => {
      const cut = new Date(now.getTime() - CAPS.tgPendingTtlMin * 60e3);
      // The follow is trusted only when it is this chat's own follow of this very key (spec §4).
      const rs = await db.query<{ id: number; chat: number; k: string; createdAt: Date; fid: number | null; label: string | null }>(
        'SELECT p.id AS id, p.chat_id AS chat, p.key AS k, p.created_at AS "createdAt", f.id AS fid, f.label AS label FROM tg_pending p LEFT JOIN follow f ON f.id = p.fid AND f.key = p.key AND f.target_id = (SELECT t.id FROM target t WHERE t.chat_id = p.chat_id) WHERE p.created_at >= $1 ORDER BY p.id LIMIT $2',
        [cut, CAPS.tgPerRun],
      );
      return rs.rows.flatMap((x): PendingRow[] => {
        const p = parseAlertKey(x.k);
        return p ? [{ id: x.id, chat: x.chat, k: x.k, lat: p.lat, lon: p.lon, createdAt: isoOut(x.createdAt), fid: x.fid ?? null, label: x.label ?? null }] : [];
      });
    }),

    finishRun: (at, counts) => guard(async () => {
      const clean = Object.fromEntries(Object.entries(counts).filter(([, v]) => Number.isFinite(v)));
      await db.query('UPDATE alert_run SET run_at = $1, last_counts = $2::jsonb WHERE id = 1', [at, JSON.stringify(clean)]);
    }),
  };
}
