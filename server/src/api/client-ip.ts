import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import cf from './cloudflare-ips.json';

export type IpMode = 'direct' | 'cloudflare';
export interface IpPolicy { mode: IpMode; trusted: ReadonlySet<string>; cloudflare?: BlockList }

const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
export const normalizeIp = (ip: string): string => ip.match(MAPPED)?.[1] ?? ip;

export function cloudflareList(v4: readonly string[], v6: readonly string[]): BlockList {
  const bl = new BlockList();
  for (const c of v4) { const [a, p] = c.split('/'); bl.addSubnet(a!, Number(p), 'ipv4'); }
  for (const c of v6) { const [a, p] = c.split('/'); bl.addSubnet(a!, Number(p), 'ipv6'); }
  return bl;
}
const CLOUDFLARE = cloudflareList(cf.v4, cf.v6);

/** The client address for rate limiting (spec §7.3, R12). A peer that is not the shared caddy
 *  gets its own address and no header is read (another container on ai-stack cannot spoof one).
 *  From caddy: the rightmost X-Forwarded-For value — the address caddy itself saw; values to its
 *  left came from the client and are ignored. Cloudflare mode trusts CF-Connecting-IP only when
 *  that edge address is inside Cloudflare's published ranges. Never stored raw. */
export function clientIp(peer: string, xff: string | null, cfConnectingIp: string | null, p: IpPolicy): string {
  const remote = normalizeIp(peer || 'unknown');
  if (!p.trusted.has(remote)) return remote;
  const last = xff?.split(',').at(-1)?.trim() ?? '';
  const edge = isIP(last) ? normalizeIp(last) : remote;
  if (p.mode === 'direct') return edge;
  const claimed = cfConnectingIp?.trim() ?? '';
  const family = isIP(edge) === 6 ? 'ipv6' : 'ipv4';
  if (isIP(claimed) && isIP(edge) && (p.cloudflare ?? CLOUDFLARE).check(edge, family)) return normalizeIp(claimed);
  return edge;
}

/** How often the trusted proxy is resolved again, and the least time between two on-demand
 *  lookups (final review M1). */
export const TRUST_REFRESH_MS = 30_000;
export const TRUST_ON_DEMAND_MS = 10_000;

/** TRUSTED_PROXY_HOST (caddy) resolved through Docker's DNS at start and every 30 s; a failed
 *  lookup trusts nobody (headers are then ignored). An untrusted peer that sends X-Forwarded-For
 *  (e.g. caddy recreated with a new address) triggers a lookup at once — in the background, at
 *  most once per 10 s — instead of keying every request on caddy's own address until the timer. */
export function trustedResolver(host: string, resolve: (h: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address), clock: () => number = Date.now) {
  let current: ReadonlySet<string> = new Set();
  let inflight: Promise<void> | null = null;
  let lastDemand = -Infinity;
  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      try { current = new Set((await resolve(host)).map(normalizeIp)); } catch { current = new Set(); } finally { inflight = null; }
    })();
    return inflight;
  };
  return {
    current: (): ReadonlySet<string> => current,
    refresh,
    /** Called for every request; returns the lookup it started (tests), else null. */
    seen(peer: string, xff: string | null): Promise<void> | null {
      if (!xff?.trim() || current.has(normalizeIp(peer || 'unknown'))) return null;
      const t = clock();
      if (t - lastDemand < TRUST_ON_DEMAND_MS) return null;
      lastDemand = t;
      return refresh();
    },
    start(everyMs = TRUST_REFRESH_MS): () => void {
      const t = setInterval(() => { void refresh(); }, everyMs);
      t.unref();
      return () => clearInterval(t);
    },
  };
}
