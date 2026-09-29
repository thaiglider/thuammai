import { readFileSync } from 'node:fs';

export type SecretReader = (name: string) => string | undefined;

/** Secrets come only from files named by `<NAME>_FILE` (compose `secrets:` → /run/secrets/…), never
 *  from a plain env variable: Portainer and `docker inspect` show env to anyone with access (R4, F7). */
export function fileSecrets(e: NodeJS.ProcessEnv, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): SecretReader {
  return (name) => {
    const p = e[`${name}_FILE`];
    if (!p) return undefined;
    try {
      const v = readFile(p).trim();
      return v === '' ? undefined : v;
    } catch {
      return undefined;
    }
  };
}
