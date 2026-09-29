/* The ONLY module in src/alerts that may write to the console (eslint no-console elsewhere).
 * The repository is public, so its Actions logs are public (spec §5.6, research §5): a log line is
 * a fixed event name and whole-number counts — never a message, stack, URL, endpoint, key, chat
 * id, label, coordinate or token. */
export type LogEvent = 'run' | 'skip' | 'send' | 'error';
export type Counts = Record<string, number>;

export const LOG_LINE_RE = /^alerts (run|skip|send|error)( [a-z0-9_]+=\d+)*$/;
const KEY_RE = /^[a-z0-9_]+$/;

export function formatCounts(event: LogEvent, counts: Counts): string {
  const parts = Object.entries(counts)
    .filter(([k, v]) => KEY_RE.test(k) && Number.isFinite(v))
    .map(([k, v]) => `${k}=${Math.max(0, Math.round(v))}`);
  return ['alerts', event, ...parts].join(' ');
}

export function logCounts(event: LogEvent, counts: Counts): void {
  console.log(formatCounts(event, counts));
}

/** An error as counts: its class name (letters/digits only) and a numeric HTTP status if any. */
export function errorCounts(e: unknown): Counts {
  if (!(e instanceof Error)) return { e_nonerror: 1 };
  const name = e.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) || 'error';
  const out: Counts = { [`e_${name}`]: 1 };
  const x = e as Error & { status?: unknown; statusCode?: unknown };
  const status = typeof x.status === 'number' ? x.status : typeof x.statusCode === 'number' ? x.statusCode : undefined;
  if (status !== undefined) out.status = status;
  return out;
}
