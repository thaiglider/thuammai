import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';

/** Held for the whole run, so two `migrate` containers never interleave (spec §5.4). */
export const MIGRATE_LOCK = 7700310000;
const FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

export class MigrateError extends Error {
  constructor(readonly code: 'checksum' | 'failed' | 'name', readonly file: string) {
    super(`migrate ${code}`);
    this.name = 'MigrateError';
  }
}

export function migrationFiles(dir: string): { version: string; sql: string; sha256: string }[] {
  return readdirSync(dir).filter((n) => n.endsWith('.sql')).sort().map((n) => {
    if (!FILE_RE.test(n)) throw new MigrateError('name', n);
    const sql = readFileSync(join(dir, n), 'utf8');
    return { version: n.slice(0, -'.sql'.length), sql, sha256: createHash('sha256').update(sql).digest('hex') };
  });
}

export const needsPostgis = (sql: string): boolean => /^-- requires: postgis\s*$/m.test(sql);

/** Our own runner (R9): files in name order, each in its own transaction, recorded with its
 *  sha256; a file that already ran with another checksum is refused. No down migrations — a bad
 *  release is undone by restoring the pre-deploy backup (spec §9.3). */
export async function migrate(db: Db, o: { dir: string; skipPostgis?: boolean }): Promise<{ applied: string[]; skipped: string[] }> {
  const files = migrationFiles(o.dir);
  return db.session(async (s) => {
    await s.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK]);
    try {
      await s.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL)');
      const done = new Map((await s.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM schema_migrations')).rows.map((r) => [r.version, r.sha256]));
      const out = { applied: [] as string[], skipped: [] as string[] };
      for (const f of files) {
        const had = done.get(f.version);
        if (had !== undefined) {
          if (had !== f.sha256) throw new MigrateError('checksum', f.version);
          continue;
        }
        if (o.skipPostgis && needsPostgis(f.sql)) { out.skipped.push(f.version); continue; }
        try {
          await s.tx(async (t) => {
            await t.exec(f.sql);
            await t.query('INSERT INTO schema_migrations (version, sha256, applied_at) VALUES ($1, $2, now())', [f.version, f.sha256]);
          });
        } catch {
          throw new MigrateError('failed', f.version);
        }
        out.applied.push(f.version);
      }
      return out;
    } finally {
      await s.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK]);
    }
  });
}
