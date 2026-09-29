// A high surrogate not followed by a low surrogate, or a low surrogate not preceded by a high
// surrogate: half of a broken pair. Left in a name, it would make encodeURIComponent throw.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Zero-width characters (U+200B–200D, U+FEFF) and bidi override/isolate formatting characters
// (U+202A–202E, U+2066–2069): invisible in a rendered label, but able to hide characters or make a
// name read backwards when shown next to other text (security review). Built from numeric code
// points rather than typed as \u escapes or literal characters, so no editor/tool round-trip can
// silently turn an escape into the real (invisible, lint-flagged) character or vice versa.
const EXTRA_STRIP = [[0x200b, 0x200d], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
  .map(([a, b]) => `\\u${a.toString(16).padStart(4, '0')}-\\u${(b as number).toString(16).padStart(4, '0')}`)
  .join('');
const STRIP_RE = new RegExp(`[<>\\u0000-\\u001f\\u007f${EXTRA_STRIP}]`, 'g');

/** User-typed names (web places, Telegram labels): no markup characters or controls, single
 *  spaces, cut by code point (never half an emoji). May return ''. */
export function cleanText(s: string, max: number): string {
  const stripped = s.replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
  return [...stripped.replace(LONE_SURROGATE, '')].slice(0, max).join('');
}
