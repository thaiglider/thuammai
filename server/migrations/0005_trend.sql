-- 0005_trend.sql — trend alerts (H4, spec 2026-09-30 §3): the current trend run of each place and
-- each follower's last trend note. All nullable, so an older image keeps reading and writing these
-- tables without touching them, and a rollback of the image needs no down migration.
ALTER TABLE point_state
  ADD COLUMN tr text NULL CHECK (tr IN ('falling', 'rising', 'fast')),
  ADD COLUMN tr_since timestamptz NULL;
ALTER TABLE follow
  ADD COLUMN trend_note text NULL CHECK (trend_note IN ('fall', 'rise', 'fast')),
  ADD COLUMN trend_at timestamptz NULL;
