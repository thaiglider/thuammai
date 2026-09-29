import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import webpush from 'web-push';

/* Run inside the image by `thuammai install` (Plan F2): stdout is written straight into the
 * secret files on the VPS — never into a log, a chat or GitHub. */
export function vapidLines(gen: () => { publicKey: string; privateKey: string } = () => webpush.generateVAPIDKeys()): string {
  const k = gen();
  return `VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\n`;
}
/** 256 bits; base64url is also valid for Telegram's secret_token. */
export const randomSecret = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function keysCli(argv: string[], out: (s: string) => void): number {
  if (argv.includes('--vapid')) { out(vapidLines()); return 0; }
  if (argv.includes('--random')) { out(`${randomSecret()}\n`); return 0; }
  out('usage: keys.mjs --vapid | --random\n');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = keysCli(process.argv.slice(2), (s) => process.stdout.write(s));
}
