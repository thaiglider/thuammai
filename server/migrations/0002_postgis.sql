-- requires: postgis
-- 0002_postgis.sql — place.geom for phase B/DSS (ST_DWithin); nothing reads it in phase 3A.
-- In production the extension already exists (created as superuser by infra/db/init/20-roles.sh,
-- Plan F2), so IF NOT EXISTS needs no privilege. PGlite has no PostGIS and skips this file (R10).
CREATE EXTENSION IF NOT EXISTS postgis;
ALTER TABLE place ADD COLUMN geom geometry(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) STORED;
CREATE INDEX place_geom ON place USING gist (geom);
