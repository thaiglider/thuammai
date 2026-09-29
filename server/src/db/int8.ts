/** Postgres int8 (OID 20) → number (spec §6.3, R8). Row ids and Telegram chat ids fit in 2^53;
 *  anything larger is a bug and must throw — never silently round to someone else's chat. */
export function parseInt8(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError('int8 outside the safe integer range');
  return n;
}
