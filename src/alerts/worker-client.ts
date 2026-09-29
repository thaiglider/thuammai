import { CAPS } from '../core/alert-config';

export interface PlaceRow { k: string; lat: number; lon: number }
export interface FollowRow {
  fid: number; targetId: number; key: string; ch: 'push' | 'tg'; label: string | null;
  endpoint: string | null; p256dh: string | null; auth: string | null; chat: number | null;
  alerted: 0 | 3 | 4; lastAlertAt: string | null; lastL4At: string | null; lastClearAt: string | null;
}
export interface FollowUpdate { fid: number; alerted: 0 | 3 | 4; lastAlertAt: string | null; lastL4At: string | null; lastClearAt: string | null }
export interface Report { follows: FollowUpdate[]; deadTargets: number[]; donePending: number[] }

/** A failed Worker call. The message is fixed: fetch errors and response bodies can contain URLs
 *  and are never kept (public logs). status 0 = network error or timeout. */
/** Error codes the job acts on; any other body is ignored (never logged). */
export type WorkerCode = 'not_configured';
export class WorkerError extends Error {
  constructor(readonly status: number, readonly code: WorkerCode | null = null) {
    super('worker request failed');
    this.name = 'WorkerError';
  }
}

export function workerClient(origin: string, token: string, fetchImpl: typeof fetch, timeoutMs = 10_000) {
  async function call<T>(method: string, path: string, body?: unknown, allowConflict = false): Promise<T | null> {
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new WorkerError(0);
    }
    if (allowConflict && res.status === 409) return null;
    if (!res.ok) {
      let code: WorkerCode | null = null;
      try { if (((await res.json()) as { error?: unknown }).error === 'not_configured') code = 'not_configured'; } catch { /* not JSON */ }
      throw new WorkerError(res.status, code);
    }
    try { return (await res.json()) as T; } catch { throw new WorkerError(res.status); }
  }

  return {
    async health(): Promise<boolean> {
      try {
        const r = await fetchImpl(`${origin}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
        return r.ok;
      } catch {
        return false;
      }
    },
    async places(): Promise<PlaceRow[]> {
      const out: PlaceRow[] = [];
      let after = '';
      for (let page = 0; page < 1000; page++) {
        const r = (await call<{ places: PlaceRow[]; next: string | null }>('GET', `/internal/v1/places?limit=2000${after ? `&after=${encodeURIComponent(after)}` : ''}`))!;
        out.push(...r.places);
        if (!r.next) break;
        after = r.next;
      }
      return out;
    },
    async getState(): Promise<{ version: number; value: string | null }> {
      return (await call<{ version: number; value: string | null }>('GET', '/internal/v1/state'))!;
    },
    /** The new version, or null when another run wrote first (409). */
    async putState(version: number, value: string): Promise<number | null> {
      const r = await call<{ version: number }>('PUT', '/internal/v1/state', { version, value }, true);
      return r === null ? null : r.version;
    },
    async targets(keys: string[]): Promise<FollowRow[]> {
      const out: FollowRow[] = [];
      for (let i = 0; i < keys.length; i += CAPS.batch) {
        const chunk = keys.slice(i, i + CAPS.batch);
        let after = 0;
        for (let page = 0; page < 1000; page++) {
          const r = (await call<{ follows: FollowRow[]; next: number | null }>('POST', '/internal/v1/targets', after ? { keys: chunk, after } : { keys: chunk }))!;
          out.push(...r.follows);
          if (r.next === null) break;
          after = r.next;
        }
      }
      return out;
    },
    async report(r: Report): Promise<void> {
      await call('POST', '/internal/v1/report', r);
    },
  };
}
export type WorkerClient = ReturnType<typeof workerClient>;
