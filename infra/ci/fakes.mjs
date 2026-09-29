// CI only: fake FCM + Telegram (HTTPS :443, cert from the CI CA), fake Pages (HTTP :8088) and fake
// Uptime Kuma (HTTP :3001 as uptime-kuma on ai-stack_ai-stack, and :8088).
// GET http://127.0.0.1:8088/__records returns everything received (names and codes only).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { join, normalize } from 'node:path';

const rec = { push: [], tg: [], kuma: [] };
let webhook = '';
const body = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const json = (res, status, v) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

https({ key: readFileSync('/certs/fake.key'), cert: readFileSync('/certs/fake.pem') }, async (req, res) => {
  const b = await body(req);
  const host = (req.headers.host ?? '').split(':')[0];
  if (host === 'fcm.googleapis.com') {
    rec.push.push({ path: req.url, bytes: b.length, ttl: req.headers.ttl ?? null, urgency: req.headers.urgency ?? null });
    res.writeHead(201);
    return res.end();
  }
  if (host === 'api.telegram.org') {
    const method = (req.url ?? '').split('/').pop();
    let j;
    try { j = JSON.parse(b.toString() || '{}'); } catch { j = {}; }
    rec.tg.push({ method, chat: j.chat_id ?? null });
    if (method === 'setWebhook') webhook = j.url ?? '';
    if (method === 'deleteWebhook') webhook = '';
    const result = method === 'getMe' ? { username: 'thuammai_ci_bot' }
      : method === 'getWebhookInfo' ? { url: webhook, pending_update_count: 0 }
        : method === 'sendMessage' ? { message_id: rec.tg.length, chat: { id: j.chat_id ?? 0, type: 'private' }, date: 0 }
          : true;
    return json(res, 200, { ok: true, result });
  }
  res.writeHead(404);
  res.end();
}).listen(443);

const plain = (req, res) => {
  const u = new URL(req.url ?? '/', 'http://fakes');
  if (u.pathname.startsWith('/api/push/')) {
    rec.kuma.push({ name: u.pathname.slice('/api/push/'.length), status: u.searchParams.get('status'), msg: u.searchParams.get('msg') });
    return json(res, 200, { ok: true });
  }
  if (u.pathname === '/__records') return json(res, 200, rec);
  if (u.pathname.startsWith('/thuammai/data/')) {
    const rel = normalize(u.pathname.slice('/thuammai/data/'.length));
    const p = join('/data', rel);
    if (rel.includes('..') || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(readFileSync(p));
  }
  res.writeHead(404);
  res.end();
};
http(plain).listen(8088);
http(plain).listen(3001);
