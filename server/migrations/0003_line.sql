-- contract: widens target's channel and row CHECKs to allow 'line' (phase-3C spec §7, R-L10) — the old release never writes 'line'
-- 0003_line.sql — LINE alerts with admin approval. Constraint names verified on PGlite 2026-09-29.
ALTER TABLE target ADD COLUMN line_user text UNIQUE CHECK (line_user ~ '^U[0-9a-f]{32}$');
ALTER TABLE target DROP CONSTRAINT target_channel_check;
ALTER TABLE target DROP CONSTRAINT target_check;
ALTER TABLE target ADD CONSTRAINT target_channel_check CHECK (channel IN ('push','tg','line'));
ALTER TABLE target ADD CONSTRAINT target_check CHECK (
     (channel = 'push' AND endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL AND chat_id IS NULL AND line_user IS NULL)
  OR (channel = 'tg'   AND chat_id IS NOT NULL AND endpoint IS NULL AND line_user IS NULL)
  OR (channel = 'line' AND line_user IS NOT NULL AND endpoint IS NULL AND chat_id IS NULL));

-- A person who asked for LINE alerts. The target (and so the follows) exists only while approved.
CREATE TABLE line_user (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      text        NOT NULL UNIQUE CHECK (user_id ~ '^U[0-9a-f]{32}$'),
  state        text        NOT NULL CHECK (state IN ('pending','approved','rejected')),
  requested_at timestamptz NOT NULL,
  decided_at   timestamptz,
  target_id    bigint REFERENCES target(id) ON DELETE SET NULL,
  held_month   text CHECK (held_month ~ '^\d{4}-\d{2}$'),
  held_reason  text CHECK (held_reason IN ('user','system','exhausted')),
  CHECK ((held_month IS NULL) = (held_reason IS NULL))
);
CREATE INDEX line_user_state ON line_user (state);

-- A location waiting for its free reply (token valid 1 minute, F4). Deleted when answered or expired.
CREATE TABLE line_pending (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     text        NOT NULL CHECK (user_id ~ '^U[0-9a-f]{32}$'),
  key         text        NOT NULL CHECK (key ~ '^-?\d{1,3}\.\d{3},-?\d{1,3}\.\d{3}$'),
  typed       boolean     NOT NULL DEFAULT false,
  reply_token text        NOT NULL CHECK (char_length(reply_token) BETWEEN 1 AND 256),
  created_at  timestamptz NOT NULL,
  claimed_at  timestamptz
);
CREATE INDEX line_pending_created ON line_pending (created_at);

-- The monthly budget (spec §6), month = Asia/Bangkok calendar month.
CREATE TABLE line_usage (
  month           text PRIMARY KEY CHECK (month ~ '^\d{4}-\d{2}$'),
  sent            integer NOT NULL DEFAULT 0 CHECK (sent >= 0),
  held            integer NOT NULL DEFAULT 0 CHECK (held >= 0),
  line_total      integer CHECK (line_total >= 0),
  line_limit      integer CHECK (line_limit >= 0),
  line_checked_at timestamptz,
  exhausted       boolean NOT NULL DEFAULT false,
  held_notice_day text,
  low_notice_day  text,
  auth_notice_day text
);
CREATE TABLE line_user_usage (
  user_id text    NOT NULL CHECK (user_id ~ '^U[0-9a-f]{32}$'),
  month   text    NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  sent    integer NOT NULL DEFAULT 0 CHECK (sent >= 0),
  PRIMARY KEY (user_id, month)
);

-- The single admin (spec §4.2, R-L2): a Telegram chat, linked with a one-time code (stored as HMAC).
CREATE TABLE admin (
  id           smallint PRIMARY KEY CHECK (id = 1),
  tg_chat      bigint,
  link_hmac    text CHECK (link_hmac ~ '^[0-9a-f]{64}$'),
  link_expires timestamptz,
  CHECK ((link_hmac IS NULL) = (link_expires IS NULL))
);
INSERT INTO admin (id) VALUES (1);
