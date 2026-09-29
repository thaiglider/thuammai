-- 0001_init.sql (D1 enforces foreign keys by default; the fake D1 in tests sets PRAGMA foreign_keys = ON itself)
CREATE TABLE target (
  id          INTEGER PRIMARY KEY,
  channel     TEXT    NOT NULL CHECK (channel IN ('push','tg')),
  endpoint    TEXT    UNIQUE,
  p256dh      TEXT,
  auth        TEXT,
  chat_id     INTEGER UNIQUE,
  tg_await    TEXT,
  created_at  TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  CHECK ((channel = 'push' AND endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL AND chat_id IS NULL)
      OR (channel = 'tg'   AND chat_id IS NOT NULL AND endpoint IS NULL))
);

CREATE TABLE place (
  key         TEXT PRIMARY KEY,
  lat         REAL NOT NULL, lon REAL NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE follow (
  id            INTEGER PRIMARY KEY,
  target_id     INTEGER NOT NULL REFERENCES target(id) ON DELETE CASCADE,
  key           TEXT    NOT NULL REFERENCES place(key),
  label         TEXT,
  created_at    TEXT    NOT NULL,
  alerted       INTEGER NOT NULL DEFAULT 0 CHECK (alerted IN (0,3,4)),
  last_alert_at TEXT,
  last_l4_at    TEXT,
  last_clear_at TEXT,
  UNIQUE (target_id, key)
);
CREATE INDEX follow_key ON follow (key);

CREATE TABLE tg_pending (
  id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, key TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (chat_id, key)
);

CREATE TABLE kv (
  name TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE counter (
  name TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (name, day)
);
