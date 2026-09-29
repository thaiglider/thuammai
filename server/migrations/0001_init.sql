-- 0001_init.sql — phase 3A schema (spec §5.1). Times are timestamptz (UTC sessions).
CREATE TABLE target (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel     text        NOT NULL CHECK (channel IN ('push','tg')),
  endpoint    text        UNIQUE CHECK (char_length(endpoint) <= 1024),
  p256dh      text,
  auth        text,
  chat_id     bigint      UNIQUE,
  tg_await    text,
  created_at  timestamptz NOT NULL,
  synced_at   timestamptz NOT NULL,
  CHECK ((channel = 'push' AND endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL AND chat_id IS NULL)
      OR (channel = 'tg'   AND chat_id IS NOT NULL AND endpoint IS NULL))
);
CREATE INDEX target_sweep ON target (channel, synced_at);

CREATE TABLE place (
  key         text PRIMARY KEY CHECK (key ~ '^-?\d{1,3}\.\d{3},-?\d{1,3}\.\d{3}$'),
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE TABLE follow (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id     bigint   NOT NULL REFERENCES target(id) ON DELETE CASCADE,
  key           text     NOT NULL REFERENCES place(key),
  label         text     CHECK (char_length(label) <= 20),
  created_at    timestamptz NOT NULL,
  alerted       smallint NOT NULL DEFAULT 0 CHECK (alerted IN (0,3,4)),
  last_alert_at timestamptz,
  last_l4_at    timestamptz,
  last_clear_at timestamptz,
  UNIQUE (target_id, key)
);
CREATE INDEX follow_key ON follow (key);

CREATE TABLE tg_pending (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id bigint NOT NULL, key text NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE (chat_id, key)
);

-- Replaces kv['alert_state'].places (phase-2 spec §3): only keys with a non-empty state. No FK to
-- place: the daily cleanup deletes orphans instead (no clash with a place deleted mid-run).
CREATE TABLE point_state (
  key        text PRIMARY KEY,
  l3         timestamptz,
  l4         timestamptz,
  below      timestamptz,
  ep         boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);

-- One row: the last processed gen + heartbeat + last run summary (numbers only).
CREATE TABLE alert_run (
  id          smallint PRIMARY KEY CHECK (id = 1),
  gen         timestamptz,
  tick_at     timestamptz NOT NULL,
  run_at      timestamptz,
  last_counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(last_counts) = 'object')
);
INSERT INTO alert_run (id, tick_at) VALUES (1, 'epoch');

CREATE TABLE counter (
  name text NOT NULL, day text NOT NULL, n integer NOT NULL, PRIMARY KEY (name, day)
);
