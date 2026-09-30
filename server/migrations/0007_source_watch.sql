-- 0007_source_watch.sql — stale-source watch (owner-approved 2026-09-30, lessons-learned §K): one
-- row per open problem ('stale:road', 'relay', …). since = first seen, notified_day = the Bangkok
-- day the admin was last told (≤ once a day); the row is deleted when the problem clears (after
-- one recovery notice if the admin was told). A new table only: an older image never touches it.
CREATE TABLE source_watch (
  key text PRIMARY KEY,
  since timestamptz NOT NULL,
  notified_day date NULL,
  recovered_at timestamptz NULL
);
