import { parseLocal, toIso07 } from '../../core/time';
import type { TmdWarning } from '../../core/types';

export const TMD_URL = 'https://data.tmd.go.th/api/WeatherWarningNews/v2/?uid=api&ukey=api12345';

const decode = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .trim();

function field(block: string, names: string[]): string {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`).exec(block);
    if (m && decode(m[1]!)) return decode(m[1]!);
  }
  return '';
}

export function parseTmd(xml: string): TmdWarning[] {
  const section = /<Warnings>([\s\S]*?)<\/Warnings>/.exec(xml)?.[1] ?? '';
  const blocks = [...section.matchAll(/<(\w+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)].map((m) => m[2]!);
  return blocks
    .map((b) => {
      const issued = parseLocal(field(b, ['AnnounceDateTime', 'IssueDateTime', 'DateTime']));
      return {
        title: field(b, ['TitleThai', 'Title', 'HeadlineThai', 'Headline']),
        body: field(b, ['DescriptionThai', 'Description']),
        issued: issued ? toIso07(issued) : null,
      };
    })
    .filter((w) => w.title || w.body);
}
