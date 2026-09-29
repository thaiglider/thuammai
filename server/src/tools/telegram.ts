import { pathToFileURL } from 'node:url';
import { fileSecrets } from '../secrets';

export const COMMANDS = [
  { command: 'list', description: 'จุดที่ติดตาม' },
  { command: 'stop', description: 'เลิกทั้งหมดและลบข้อมูล' },
  { command: 'help', description: 'วิธีใช้' },
];
export const DESCRIPTION = 'ดูความเสี่ยงน้ำท่วมและรับแจ้งเตือน (อาสาสมัคร ไม่ใช่หน่วยงานทางการ)';

type WebhookInfo = { url?: string; pending_update_count?: number; last_error_message?: string };
interface Result { url: string; pending: number; lastError: string | null }

/** Telegram said no for good: the token is malformed, or the Bot API answered 401/404 (unknown or
 *  revoked token). Anything else (network, 5xx, 429) only means "could not check" — the host scripts
 *  keep the stored token then (ruling T7-3). */
export class TelegramRejected extends Error {}
/** Exit code of `telegram.mjs getme` for a definitive rejection (1 = could not check). */
export const EXIT_REJECTED = 3;

function checkToken(token: string): void {
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new TelegramRejected('TELEGRAM_BOT_TOKEN is missing or malformed');
}
/** A Bot API caller: the token is only ever in the request URL, never in an error message. */
function botApi(token: string, fetchImpl: typeof fetch) {
  return async <T>(method: string, body: Record<string, unknown> = {}): Promise<T> => {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!j.ok) {
      const msg = `${method} failed: ${j.description ?? r.status}`;
      throw r.status === 401 || r.status === 404 ? new TelegramRejected(msg) : new Error(msg);
    }
    return j.result as T;
  };
}
const toResult = (info: WebhookInfo): Result => ({ url: info.url ?? '', pending: info.pending_update_count ?? 0, lastError: info.last_error_message ?? null });

export async function setupTelegram(o: { token?: string; secret?: string; origin?: string; fetchImpl?: typeof fetch }): Promise<Result> {
  const { token = '', secret = '', origin = '' } = o;
  checkToken(token);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error('TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z a-z 0-9 _ -');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) throw new Error('API_HOST must be a host name (the origin is https://<API_HOST>)');
  const call = botApi(token, o.fetchImpl ?? fetch);
  await call('setWebhook', { url: `${origin}/v1/telegram`, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  await call('setMyCommands', { commands: COMMANDS });
  await call('setMyDescription', { description: DESCRIPTION });
  return toResult(await call<WebhookInfo>('getWebhookInfo'));
}

/** `delete`: the bot stops answering and stops promising answers (thuammai pause, R28). */
export async function deleteTelegramWebhook(o: { token?: string; fetchImpl?: typeof fetch }): Promise<Result> {
  const { token = '' } = o;
  checkToken(token);
  const call = botApi(token, o.fetchImpl ?? fetch);
  await call('deleteWebhook', { drop_pending_updates: true });
  return toResult(await call<WebhookInfo>('getWebhookInfo'));
}

/** `getme`: setup checks the token and learns the bot username (public). */
export async function getMe(o: { token?: string; fetchImpl?: typeof fetch }): Promise<string> {
  const { token = '' } = o;
  checkToken(token);
  const me = await botApi(token, o.fetchImpl ?? fetch)<{ username?: string }>('getMe');
  if (typeof me.username !== 'string') throw new Error('getMe failed: no username');
  return me.username;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  const read = fileSecrets(process.env);
  const token = read('TELEGRAM_BOT_TOKEN');
  const show = (r: Result) => {
    console.log(`webhook: ${r.url || 'none'}`);
    console.log(`pending updates: ${r.pending}`);
    console.log(`last error: ${r.lastError ?? 'none'}`);
  };
  const job = mode === 'set'
    ? setupTelegram({ token, secret: read('TELEGRAM_WEBHOOK_SECRET'), origin: `https://${process.env.API_HOST ?? ''}` }).then((r) => { show(r); if (r.lastError) process.exitCode = 1; })
    : mode === 'delete'
      ? deleteTelegramWebhook({ token }).then((r) => { show(r); if (r.url !== '') process.exitCode = 1; })
      : mode === 'getme'
        ? getMe({ token }).then((u) => { console.log(`username=${u}`); })
        : Promise.reject(new Error('usage: telegram.mjs set|delete|getme'));
  job.catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : 'failed');
    if (e instanceof TelegramRejected) console.log('rejected');
    process.exit(e instanceof TelegramRejected ? EXIT_REJECTED : 1);
  });
}
