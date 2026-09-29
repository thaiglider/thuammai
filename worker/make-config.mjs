// Usage: node worker/make-config.mjs <D1 database id> | --local
// Writes worker/wrangler.jsonc from worker/wrangler.template.jsonc. Prints nothing about the id.
import { readFileSync, writeFileSync } from 'node:fs';

const LOCAL = '00000000-0000-0000-0000-000000000000';
const arg = process.argv[2];
const id = arg === '--local' ? LOCAL : arg;
if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
  console.error('usage: node worker/make-config.mjs <D1 database id (uuid)> | --local');
  process.exit(1);
}
const template = readFileSync(new URL('./wrangler.template.jsonc', import.meta.url), 'utf8');
if (!template.includes('__D1_DATABASE_ID__')) throw new Error('placeholder __D1_DATABASE_ID__ missing from the template');
writeFileSync(new URL('./wrangler.jsonc', import.meta.url), template.replace('__D1_DATABASE_ID__', id));
console.log('wrote worker/wrangler.jsonc');
