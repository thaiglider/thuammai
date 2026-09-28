export interface KV { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void; readonly persistent: boolean }
type Backing = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const PREFIX = 'thuammai.';

export function createStorage(backing?: Backing | null): KV {
  const mem = new Map<string, string>();
  let ok = false;
  if (backing) {
    try { backing.setItem(`${PREFIX}__probe`, '1'); backing.removeItem(`${PREFIX}__probe`); ok = true; } catch { ok = false; }
  }
  return {
    persistent: ok,
    get(k) { if (ok) { try { return backing!.getItem(PREFIX + k); } catch { /* fall through */ } } return mem.get(k) ?? null; },
    set(k, v) { mem.set(k, v); if (ok) { try { backing!.setItem(PREFIX + k, v); } catch { /* quota or denied */ } } },
    remove(k) { mem.delete(k); if (ok) { try { backing!.removeItem(PREFIX + k); } catch { /* ignore */ } } },
  };
}

export function getJson<T>(kv: KV, key: string, fallback: T): T {
  const raw = kv.get(key);
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function setJson(kv: KV, key: string, value: unknown): void {
  kv.set(key, JSON.stringify(value));
}

export function browserStorage(): KV {
  try { return createStorage(globalThis.localStorage); } catch { return createStorage(null); }
}
