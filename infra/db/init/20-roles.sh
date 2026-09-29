#!/bin/bash
# Runs once when the pgdata volume is created (docker-entrypoint-initdb.d), after the image's own
# 10_postgis.sh. Roles of spec §4.4 / R29; passwords only from the compose secret files.
set -euo pipefail
owner_pw="$(cat /run/secrets/pg_owner)"
app_pw="$(cat /run/secrets/pg_app)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$owner_pw" -v app_pw="$app_pw" <<'SQL'
CREATE ROLE thuammai_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE thuammai_app LOGIN PASSWORD :'app_pw';
ALTER ROLE thuammai_app SET statement_timeout = '15s';
ALTER ROLE thuammai_app SET lock_timeout = '5s';
ALTER ROLE thuammai_app SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE thuammai OWNER TO thuammai_owner;
ALTER SCHEMA public OWNER TO thuammai_owner;
REVOKE ALL ON DATABASE thuammai FROM PUBLIC;
GRANT CONNECT ON DATABASE thuammai TO thuammai_app;
GRANT USAGE ON SCHEMA public TO thuammai_app;
ALTER DEFAULT PRIVILEGES FOR ROLE thuammai_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO thuammai_app;
ALTER DEFAULT PRIVILEGES FOR ROLE thuammai_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO thuammai_app;
-- As superuser here, so migration 0002 (run by thuammai_owner) only finds it existing (PostGIS is not a trusted extension).
CREATE EXTENSION IF NOT EXISTS postgis;
SQL
