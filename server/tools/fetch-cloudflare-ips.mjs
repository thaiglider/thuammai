// Refreshes server/src/api/cloudflare-ips.json right before the image build (spec §7.3, R12).
// Exit 1 when the list cannot be fetched or looks wrong — the workflow then builds nothing.
import { writeFileSync } from 'node:fs';

const get = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return (await r.text()).split('\n').map((s) => s.trim()).filter(Boolean);
};
try {
  const v4 = await get('https://www.cloudflare.com/ips-v4');
  const v6 = await get('https://www.cloudflare.com/ips-v6');
  const ok4 = v4.length >= 5 && v4.every((c) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(c));
  const ok6 = v6.length >= 3 && v6.every((c) => /^[0-9a-f:]+\/\d{1,3}$/i.test(c));
  if (!ok4 || !ok6) throw new Error('unexpected Cloudflare IP list');
  writeFileSync('server/src/api/cloudflare-ips.json', `${JSON.stringify({ fetchedAt: new Date().toISOString().slice(0, 10), v4, v6 }, null, 2)}\n`);
  console.log(`cloudflare ips: v4=${v4.length} v6=${v6.length}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : 'failed');
  process.exit(1);
}
