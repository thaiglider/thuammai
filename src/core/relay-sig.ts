import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256(key, `${time}.` bytes followed by body). Shared by the relay and flood-api. */
export function relaySignature(key: Buffer | string, time: number, body: Uint8Array): string {
  return createHmac('sha256', key).update(`${time}.`).update(body).digest('hex');
}

/** Constant-time check of a hex signature; false for anything malformed. */
export function relaySigOk(key: Buffer | string, time: number, body: Uint8Array, sig: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
  const want = Buffer.from(relaySignature(key, time, body), 'hex');
  const got = Buffer.from(sig, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}
