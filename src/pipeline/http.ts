export const UA = 'thuammai/1.0 (+https://github.com/thaiglider/thuammai)';
export const THAIWATER_HEADERS: Record<string, string> = {
  Referer: 'https://www.thaiwater.net/',
  'User-Agent': `Mozilla/5.0 (compatible; ${UA})`,
  Accept: 'application/json',
};

export interface HttpOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

/** 2 attempts × 45 s + 5 s pause stays well inside the pipeline job timeout even for the slowest group. */
export const HTTP_DEFAULTS = { timeoutMs: 45_000, retries: 1, retryDelayMs: 5_000 } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getText(url: string, opts: HttpOpts = {}): Promise<string> {
  const {
    headers = {}, timeoutMs = HTTP_DEFAULTS.timeoutMs, retries = HTTP_DEFAULTS.retries, retryDelayMs = HTTP_DEFAULTS.retryDelayMs,
  } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getJson<T = unknown>(url: string, opts: HttpOpts = {}): Promise<T> {
  const body = await getText(url, opts);
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error(`Response from ${url} is not JSON: ${trimmed.slice(0, 60)}`);
  }
  return JSON.parse(trimmed) as T;
}
