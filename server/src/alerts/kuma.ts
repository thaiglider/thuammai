/** One Uptime Kuma push (spec §10.1): GET <push url>?status=up|down&msg=<codes>&ping=. The URL
 *  holds a token (a secret) and is never logged; 5 s timeout; a failure never affects the caller.
 *  Redirects are never followed (final review M4): a 3xx — e.g. an auth login page in front of
 *  Kuma — would otherwise end in a 200 that Kuma never recorded. */
export async function kumaPush(url: string, status: 'up' | 'down', msg: string, fetchImpl: typeof fetch, timeoutMs = 5000): Promise<boolean> {
  try {
    const u = new URL(url);
    u.search = '';
    u.searchParams.set('status', status);
    u.searchParams.set('msg', msg || 'OK');
    u.searchParams.set('ping', '');
    const r = await fetchImpl(u.href, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await r.body?.cancel().catch(() => undefined);
    return r.ok && r.type !== 'opaqueredirect';
  } catch {
    return false;
  }
}
