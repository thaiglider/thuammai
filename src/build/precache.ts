/** Build-time helpers over Vite's `.vite/manifest.json` (used by vite.config.ts and tools/check-budget.mjs).
 *  No imports, only erasable TypeScript, so Node can also load it directly. */
export interface ManifestChunk { file: string; css?: string[]; assets?: string[]; imports?: string[]; dynamicImports?: string[] }
export type ViteManifest = Record<string, ManifestChunk>;

/** Manifest keys reachable from `key` through static imports (never dynamic ones), in visit order. */
export function staticKeys(m: ViteManifest, key: string): string[] {
  const seen: string[] = [];
  const visit = (k: string): void => {
    if (seen.includes(k)) return;
    if (!m[k]) throw new Error(`Vite manifest has no entry ${k}`);
    seen.push(k);
    for (const i of m[k].imports ?? []) visit(i);
  };
  visit(key);
  return seen;
}

/** Output files a chunk needs up front: its JS, CSS and assets and those of its static imports. */
export function staticClosure(m: ViteManifest, key: string): string[] {
  const out = new Set<string>();
  for (const k of staticKeys(m, key)) {
    const c = m[k]!;
    out.add(c.file);
    for (const f of c.css ?? []) out.add(f);
    for (const f of c.assets ?? []) out.add(f);
  }
  return [...out].sort();
}

/** Files needed only by `lazyKey` (its static closure minus the entry's). */
export function lazyOnly(m: ViteManifest, entryKey: string, lazyKey: string): string[] {
  const entry = new Set(staticClosure(m, entryKey));
  return staticClosure(m, lazyKey).filter((f) => !entry.has(f));
}

/** What the service worker precaches from dist/assets: the entry's static closure plus every
 *  non-script asset (fonts). Lazy JS/CSS (map, MapLibre worker, QR) is cached on first use instead. */
export function precacheAssets(m: ViteManifest, entryKey: string, assetFiles: readonly string[]): string[] {
  const need = new Set(staticClosure(m, entryKey));
  return assetFiles.filter((f) => need.has(f) || !/\.(m?js|css)$/.test(f)).sort();
}
