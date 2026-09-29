import { errorCounts, logLine, type Counts, type Service } from '../../src/alerts/log';

export type CrashProc = Pick<NodeJS.Process, 'on' | 'exit'>;

/** Last resort for a long-running service (spec §7.4): an uncaught exception or an unhandled
 *  rejection prints exactly ONE counts-only line — which of the two, and the error class — and the
 *  process exits 1 (Docker restarts it). Never a message or a stack: either may hold SQL, a
 *  parameter, a URL with a token, an endpoint or a key. A second failure while exiting is silent. */
export function installCrashHandler(service: Service, proc: CrashProc = process, log: (c: Counts) => void = (c) => logLine(service, 'error', c)): void {
  let fired = false;
  const fail = (kind: 'uncaught_exception' | 'unhandled_rejection') => (e: unknown): void => {
    if (fired) return;
    fired = true;
    try {
      log({ [kind]: 1, ...errorCounts(e) });
    } catch {
      // Nothing else may be printed.
    } finally {
      proc.exit(1);
    }
  };
  proc.on('uncaughtException', fail('uncaught_exception'));
  proc.on('unhandledRejection', fail('unhandled_rejection'));
}

export type ExitProc = Pick<NodeJS.Process, 'exit'> & { exitCode?: NodeJS.Process['exitCode'] };

/** The service's exit(code): close resources (at most `graceMs`), then exit. The FIRST code wins —
 *  a crash or watchdog exit(1) is never turned into 0 by a SIGTERM that follows (or vice versa). */
export function onceExit(close: () => Promise<unknown>, proc: ExitProc = process, graceMs = 3_000): (code: number) => void {
  let first: number | null = null;
  return (code) => {
    if (first !== null) return;
    const c = code;
    first = c;
    proc.exitCode = c;
    setTimeout(() => proc.exit(c), graceMs).unref();
    void close().catch(() => undefined).finally(() => proc.exit(c));
  };
}
