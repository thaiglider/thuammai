/* The ONLY module in src/alerts and server/src (owner tools aside) that may write to the console
 * (ESLint no-console elsewhere). Logs are viewed in dozzle on a shared host (spec §7.4, F7), so a
 * line is a service, a fixed event name and whole-number counts — never a message, stack, URL,
 * endpoint, key, chat id, label, coordinate, IP, token, SQL or SQL parameter. */
export type Service = 'alerts' | 'api';
export type LogEvent = 'run' | 'skip' | 'send' | 'error' | 'tick' | 'cleanup' | 'start' | 'stop' | 'stats' | 'migrate';
export type Counts = Record<string, number>;

export const LOG_LINE_RE = /^(alerts|api) [a-z_]+( [a-z0-9_]+=\d+)*$/;
const KEY_RE = /^[a-z0-9_]+$/;

export function formatLine(service: Service, event: LogEvent, counts: Counts): string {
  const parts = Object.entries(counts)
    .filter(([k, v]) => KEY_RE.test(k) && Number.isFinite(v))
    .map(([k, v]) => `${k}=${Math.max(0, Math.round(v))}`);
  return [service, event, ...parts].join(' ');
}
export const formatCounts = (event: LogEvent, counts: Counts): string => formatLine('alerts', event, counts);

export function logLine(service: Service, event: LogEvent, counts: Counts): void {
  console.log(formatLine(service, event, counts));
}
export const logCounts = (event: LogEvent, counts: Counts): void => logLine('alerts', event, counts);

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
