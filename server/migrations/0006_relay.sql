-- 0006_relay.sql — BMA relay (Plan M): one row, named 'bma', holding the last good payload the Thai
-- relay POSTed. A new table only, so an older image never touches it and a rollback needs nothing.
-- body/received_at/fetched_at are the last GOOD report (an error report never overwrites them);
-- relay_time is the newest accepted x-relay-time (replay guard); last_report_at/last_error say the
-- relay is alive and what it last said about BMA.
CREATE TABLE relay_blob (
  name text PRIMARY KEY,
  received_at timestamptz NULL,
  fetched_at timestamptz NULL,
  relay_time bigint NOT NULL,
  body jsonb NULL,
  last_report_at timestamptz NOT NULL,
  last_error text NULL
);
