import { existsSync, readFileSync } from 'node:fs';
import { isSkillFile, SKILL_MAX_BYTES } from '../core/skill';

function accept(x: unknown): string | null {
  if (!isSkillFile(x)) return null;
  const text = JSON.stringify(x);
  return text.length <= SKILL_MAX_BYTES ? text : null;
}

/** The skill.json to publish: the file downloaded from the newest archive Release, else the copy
 *  currently on the site, else null (the page then says there is no result yet). Never throws. */
export async function loadSkill(path: string | undefined, siteUrl: string | undefined, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (path && existsSync(path)) {
    try {
      const s = accept(JSON.parse(readFileSync(path, 'utf8')));
      if (s) return s;
    } catch { /* fall through */ }
  }
  if (siteUrl) {
    try {
      const res = await fetchImpl(`${siteUrl.replace(/\/$/, '')}/data/skill.json?v=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const s = accept(await res.json());
        if (s) return s;
      }
    } catch { /* fall through */ }
  }
  return null;
}
