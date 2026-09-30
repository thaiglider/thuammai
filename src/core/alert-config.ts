/** Alert constants (phase-2 spec §1, phase-3A spec §7.5). Shared by the web app, the server and — until Plan F3 — the Worker. */
export const ALERT = {
  level: 3,                // alert when the shown level (after hysteresis) is ≥ 3
  repeatH: 6,              // per (follower × place): at most one level-3 alert per 6 h
  level4MinGapMin: 60,     // repeated level-4 alerts (4→3→4) at least 60 min apart
  clearHoldMin: 60,        // "เลิกเตือน" once the shown level stays < 3 for ≥ 60 min
  hystHoldMin: 30,         // equals the web card's HOLD_MS (test pins it)
  maxSnapshotAgeMin: 30,   // snapshot or a carried water source older than this → silence
  keyDecimals: 3,          // stored coordinates are rounded to 3 decimals (~110 m)
} as const;
/** Trend alerts (H4 spec §2): how long a trend must persist, and the gap between two trend alerts (per follower × place). */
export const TREND_ALERT = { holdMin: 30, minGapMin: 180, afterAlertMin: 60 } as const;
export const PUSH_TTL_S = { alert: 10_800, clear: 3_600, trend: 10_800 } as const;
export const CAPS = {
  placesPerTarget: 10,
  // Phase 3A (spec §7.5, R18): no D1 quota any more; bounded by the RAM given to `alerts` (perf test).
  maxTargets: 50_000,
  maxPlaces: 100_000,
  newTargetsPerDay: 10_000,
  newPlacesPerTargetPerDay: 30, // per-target churn cap (spec §8 review): caps repeated resubscribe-with-new-places abuse
  pushPerRun: 20_000, tgPerRun: 8_000,
  tgLabelMax: 20, tgPendingPerChat: 3, tgPendingTtlMin: 30,
  tgAwaitMin: 15, // the "name this place" wait after a follow expires (final review I2)
  batch: 200,
} as const;
// subscribePerIpPerDay: 200 — Thai mobile networks share IPv4 via CGNAT; worst case ~13k D1 rows/day per IP.
// tgUpdatesPerChatPerDay: a follow/unfollow loop at the 20/min burst cap could otherwise write
// ~28,800 counter rows/day from one chat; 300 caps that while leaving normal use (a handful of
// updates) untouched.
export const RATE = { subscribePerIpPerMin: 10, subscribePerIpPerDay: 200, subscribePerTargetPerHour: 20, tgUpdatesPerChatPerMin: 20, tgUpdatesPerChatPerDay: 300 } as const;
export const BODY_MAX = { public: 4_096, telegram: 65_536, internal: 1_048_576 } as const;
export const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'] as const;
export const PUSH_HOST_SUFFIX = '.notify.windows.com'; // WNS (Edge on Windows)
/** The Worker origin baked into the web build: https, a dotted host, optional port, no path. */
export const ALERTS_ORIGIN_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/;

/** LINE (phase-3C spec §6, R-L4). The first ten values are the spec's; the last four are Plan G's (G-10, spec §5.1). */
export const LINE = {
  maxApproved: 20,
  placesPerUser: 2,
  perUserMonth: 10,       // push messages per person per month (level 4 is not held by this)
  monthlyLimit: 300,      // F1: the free plan in Thailand; GET quota may lower it, never raise it
  reserve: 40,            // kept for level 4 and welcome messages
  pendingMaxAgeS: 45,     // alerts answers line_pending rows at most this old (reply token: 1 min, F4)
  pendingDropS: 60,       // alerts drops a row only past this age — the LINE reply token lives 1 minute
  apiFallbackS: 40,       // the api answers an unclaimed row itself after this long
  requestsPending: 50,    // "ปิดรับคำขอชั่วคราว" at this many pending requests
  rejectCooldownDays: 30,
  linkCodeTtlMin: 10,
  pendingPerUser: 3,
  eventsPerRequest: 5,
  replyTimeoutMs: 1500,
  answersPerTick: 100,
} as const;
