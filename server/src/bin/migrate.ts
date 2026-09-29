import { errorCounts, logLine } from '../../../src/alerts/log';
import { dbConn } from '../api/config';
import { MigrateError, migrate } from '../db/migrate';
import { createPool, poolDb } from '../db/pg';
import { fileSecrets } from '../secrets';

// One-shot before every deploy (spec §9.3 step 4), as thuammai_owner (compose sets PGUSER).
const conn = dbConn(process.env, fileSecrets(process.env));
if (!conn) {
  logLine('api', 'error', { config_missing: 1 });
  process.exit(1);
}
const pool = createPool(conn, { max: 1, applicationName: 'thuammai-migrate' });
try {
  const r = await migrate(poolDb(pool), { dir: process.env.MIGRATIONS_DIR || 'server/migrations', skipPostgis: process.env.MIGRATE_SKIP_POSTGIS === '1' });
  logLine('api', 'migrate', { applied: r.applied.length, skipped: r.skipped.length });
} catch (e) {
  logLine('api', 'error', e instanceof MigrateError ? { [`migrate_${e.code}`]: 1 } : errorCounts(e));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
