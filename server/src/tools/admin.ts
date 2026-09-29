import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LINE } from '../../../src/core/alert-config';
import { dbConn } from '../api/config';
import { adminCodeHmac } from '../api/line-admin';
import type { Db } from '../db/db';
import { createPool, poolDb } from '../db/pg';
import { fileSecrets } from '../secrets';

/* `thuammai admin link|unlink` (phase-3C spec §4.2, G-3) — run inside the api container, the only one
 * with the database and RATE_HMAC_KEY: `compose exec -T api node dist/tools/admin.mjs link`. */

/** No 0/O/1/I; 32 characters so byte mod 32 is unbiased. */
export const ADMIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newAdminCode = (rand: (n: number) => Buffer = randomBytes): string => [...rand(8)].map((b) => ADMIN_CODE_ALPHABET[b % 32]).join('');

/** A new one-time code (the previous one stops working), valid LINE.linkCodeTtlMin minutes. */
export async function adminLink(db: Db, key: string, now: Date, code: string = newAdminCode()): Promise<string> {
  await db.query('UPDATE admin SET link_hmac = $1, link_expires = $2 WHERE id = 1', [adminCodeHmac(key, code), new Date(now.getTime() + LINE.linkCodeTtlMin * 60e3)]);
  return code;
}
export async function adminUnlink(db: Db): Promise<void> {
  await db.query('UPDATE admin SET tg_chat = NULL, link_hmac = NULL, link_expires = NULL WHERE id = 1');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  const read = fileSecrets(process.env);
  const conn = dbConn(process.env, read);
  const key = read('RATE_HMAC_KEY');
  if (!conn || !key || (mode !== 'link' && mode !== 'unlink')) {
    console.error('usage: admin.mjs link|unlink (inside the api container)');
    process.exit(2);
  }
  const pool = createPool(conn, { max: 1, applicationName: 'thuammai-admin' });
  const db = poolDb(pool);
  const job = mode === 'link' ? adminLink(db, key, new Date()).then((code) => console.log(`code=${code}`)) : adminUnlink(db).then(() => console.log('unlinked'));
  job.catch(() => { console.error('failed'); process.exitCode = 1; }).finally(() => { void pool.end(); });
}
