const NUM_RE = /(\d{1,3}(?:\.\d+)?)(?:\s*[-–]\s*(\d{1,3}(?:\.\d+)?))?\s*(?:ซม\.?|ซ\.ม\.?|เซนติเมตร|เซน|cm)/gi;
const NOT_WATER_BEFORE = /(?:ผู้ใหญ่|เด็ก|คน)[^\d]{0,6}สูง[^\d]{0,6}$|ส่วนสูง[^\d]{0,6}$/;
const OBJECT_WORD_RE = /กระสอบ|กำแพง|คันกั้น|ร้าว|กว้าง|ยาว|หลุม|ทรุด|ขาด/g;
const WATER_WORD_RE = /น้ำ|ท่วม/;
const BODY: [RegExp, number][] = [
  [/ข้อเท้า|ตาตุ่ม/, 10],
  [/หน้าแข้ง|น่อง/, 25],
  [/หัวเข่า|ระดับเข่า|ถึงเข่า|ท่วมเข่า|เข่า/, 45],
  [/ต้นขา|โคนขา/, 60],
  [/เอว|สะเอว/, 90],
  [/หน้าอก|ระดับอก|ถึงอก|ท่วมอก/, 120],
];

// The whitespace-delimited word immediately preceding the number (not the
// zero-length gap between a space and the digits themselves).
function tokenBefore(text: string, index: number): string {
  const before = text.slice(0, index).replace(/\s+$/, '');
  return before.split(/\s+/).pop() ?? '';
}

// An object word (road/sandbag/wall/crack measurement) only disqualifies a
// number when it isn't itself preceded, within the same token, by a water
// word — e.g. "น้ำท่วมยาวตลอดซอยสูง" keeps ยาว legitimate because น้ำท่วม
// precedes it, whereas "ถนนขาด" has no water word before ขาด.
function tokenExcludedByObjectWord(token: string): boolean {
  for (const m of token.matchAll(OBJECT_WORD_RE)) {
    if (!WATER_WORD_RE.test(token.slice(0, m.index))) return true;
  }
  return false;
}

export function parseDepthCm(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(NUM_RE)) {
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 20), idx);
    if (NOT_WATER_BEFORE.test(before)) continue;
    if (tokenExcludedByObjectWord(tokenBefore(text, idx))) continue;
    const v = Math.max(Number(m[1]), m[2] ? Number(m[2]) : 0);
    if (v > 0 && v <= 300) best = Math.max(best ?? 0, v);
  }
  const bodyText = text.replace(/เข่าอ่อน/g, '');
  for (const [re, cm] of BODY) if (re.test(bodyText)) best = Math.max(best ?? 0, cm);
  return best;
}

export const isImpassable = (text: string) => /ผ่านไม่ได้|(?<!เ)ปิดถนน|(?<!เ)ปิดการจราจร/.test(text);
export const isPassable = (text: string) => !isImpassable(text) && /ผ่านได้/.test(text);
export const isReceded = (text: string) => /น้ำลดแล้ว|น้ำแห้งแล้ว|ไม่มีน้ำท่วมแล้ว/.test(text);

export function sanitizeText(text: string, max = 140): string {
  const s = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '…')
    .replace(/(?:\+?66|0)\d(?:[\s-]?\d){7,9}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
