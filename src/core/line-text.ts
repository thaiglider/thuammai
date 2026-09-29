import { NO_OFFICIAL_ORDER } from './advice';
import { ALERT, LINE } from './alert-config';
import { LEVEL_TH } from './labels';
import { cleanText } from './text';
import { NOT_A_REPORT_TH } from './tg-text';
import type { Level } from './types';

/* Every text of the LINE channel (phase-3C spec §4.1) and of its Telegram admin (spec §4.2). Plain
 * text only; every string passes honestyViolations (tests/core/line-text.test.ts). */

export type LineState = 'pending' | 'approved' | 'rejected';
/** Why a person's alerts were held this month: their own 10 ('user'), only the level-4 reserve is
 *  left ('system' — danger level still goes out), or LINE sends nothing more ('exhausted': a 429,
 *  or the whole monthly limit used). */
export type HeldReason = 'user' | 'system' | 'exhausted';

/** Typed commands: the whole message, trimmed (spec §4.1). */
export const LINE_CMD = { request: 'ขอรับแจ้งเตือน', list: 'รายการ', stop: 'เลิก', help: 'วิธีใช้' } as const;
/** LINE postback data — strict shapes, like Telegram's CB. */
export const LPB = {
  follow: /^lf:(\d{1,2}\.\d{3},\d{2,3}\.\d{3})$/,
  unfollow: /^lu:(\d{1,12})$/,
  stopAll: /^ld:all$/,
  dismiss: /^no$/,
} as const;
/** The admin's Telegram buttons: approve / reject a request, revoke an approved person. */
export const ACB = { approve: /^la:(\d{1,12})$/, reject: /^lr:(\d{1,12})$/, revoke: /^lv:(\d{1,12})$/ } as const;

export const LINE_LOCATION_BUTTON_TH = 'ส่งตำแหน่ง';
export const LINE_STOP_ALL_BUTTON_TH = 'ลบทั้งหมด';
export const LINE_CANCEL_BUTTON_TH = 'ยกเลิก';
export const lineUnfollowButtonText = (label: string): string => `เลิก ${label}`;

export const LINE_LIMIT_NOTE_TH = `LINE แจ้งได้จำกัด ~${LINE.perUserMonth} ครั้ง/เดือน ถ้าครบจะไม่ได้รับ — เปิด Telegram หรือ Web Push ควบคู่`;
export const LINE_PRIVACY_TH = 'ถ้ารับแจ้งเตือนทาง LINE: เก็บ LINE user id (ไม่ใช่ชื่อ) และพิกัดโดยประมาณของจุดที่ติดตาม · ชื่อที่แสดงใน LINE ถูกส่งให้แอดมินใน Telegram ครั้งเดียวตอนขอสิทธิ์ ไม่ถูกเก็บ · ลบทั้งหมดเมื่อพิมพ์ เลิก หรือบล็อกบัญชี';

/** Anything else typed (spec §4.1 step 6): how to send a place + the emergency numbers (like OTHER_TH). */
export const LINE_OTHER_TH = [
  'ส่งตำแหน่งมาเพื่อดูความเสี่ยงน้ำท่วม:',
  '• มือถือ: แตะ "ส่งตำแหน่ง" ด้านล่าง หรือ + → ตำแหน่ง → เลื่อนหมุดหรือค้นหาสถานที่ → แชร์',
  '• คอมพิวเตอร์: พิมพ์พิกัด เช่น 13.681, 102.084 หรือวางลิงก์ Google Maps แบบเต็มที่มีพิกัด',
  `พิมพ์ "${LINE_CMD.help}" · ${NOT_A_REPORT_TH}`,
].join('\n');

export function lineWelcomeText(siteUrl: string): string {
  return [
    'ส่งตำแหน่งมาเพื่อดูระดับความเสี่ยงน้ำท่วมของจุดนั้นได้ทันที',
    `ถ้าต้องการรับแจ้งเตือนทาง LINE พิมพ์ "${LINE_CMD.request}" (แอดมินอนุมัติ · ${LINE_LIMIT_NOTE_TH})`,
    `รับแจ้งเตือนได้ทันทีโดยไม่ต้องขอ: Web Push หรือ Telegram — ดูบนเว็บ: ${siteUrl}`,
    NOT_A_REPORT_TH,
    NO_OFFICIAL_ORDER,
  ].join('\n');
}

export const LINE_REQUESTED_TH = 'ส่งคำขอแล้ว รอแอดมินอนุมัติ — ระหว่างนี้ส่งตำแหน่งเพื่อดูระดับได้';
export const LINE_REQUEST_PENDING_TH = 'คำขอของคุณรอแอดมินอยู่ — ระหว่างนี้ส่งตำแหน่งเพื่อดูระดับได้';
export const LINE_ALREADY_APPROVED_TH = 'คุณได้รับสิทธิ์รับแจ้งเตือนทาง LINE แล้ว — ส่งตำแหน่งแล้วแตะ "ติดตามจุดนี้"';
export const lineRejectedText = (siteUrl: string): string => `ยังไม่ได้รับสิทธิ์รับแจ้งเตือนทาง LINE — ใช้ Web Push หรือ Telegram ได้ทันที: ${siteUrl}`;
export const LINE_REQUEST_LIMIT_TH = 'ขอสิทธิ์ได้วันละครั้ง — ลองใหม่พรุ่งนี้';
export const LINE_REQUESTS_CLOSED_TH = 'ปิดรับคำขอชั่วคราว — ใช้ Web Push หรือ Telegram บนเว็บแทน';
export const lineApprovedText = (): string =>
  [`ได้รับสิทธิ์รับแจ้งเตือนทาง LINE แล้ว — ส่งตำแหน่งแล้วแตะ "ติดตามจุดนี้" (ได้ไม่เกิน ${LINE.placesPerUser} จุด)`, LINE_LIMIT_NOTE_TH, NO_OFFICIAL_ORDER].join('\n');
export const lineFollowedText = (label: string): string => `ติดตาม '${label}' แล้ว\n${LINE_LIMIT_NOTE_TH}`;
export const LINE_NOT_APPROVED_FOLLOW_TH = `ติดตามจุดได้เฉพาะผู้ที่แอดมินอนุมัติแล้ว — พิมพ์ "${LINE_CMD.request}" เพื่อขอสิทธิ์ (ส่งตำแหน่งดูระดับได้เสมอ)`;
export const LINE_MAX_FOLLOWS_TH = `ติดตามครบ ${LINE.placesPerUser} จุดแล้ว — พิมพ์ "${LINE_CMD.list}" เพื่อเลิกบางจุด`;
export const LINE_NO_FOLLOWS_TH = 'ยังไม่ได้ติดตามจุดใด — ส่งตำแหน่งมาได้เลย';
export const LINE_STOP_CONFIRM_TH = 'ลบจุดที่ติดตาม สิทธิ์รับแจ้งเตือน และข้อมูลทั้งหมดของคุณในบัญชี LINE นี้?';
export const LINE_STOPPED_TH = `ลบข้อมูลทั้งหมดของคุณแล้ว จะไม่ได้รับแจ้งเตือนทาง LINE อีก — ถ้าต้องการอีกครั้ง พิมพ์ "${LINE_CMD.request}"`;

/** The line that leads a point answer while this person's alerts are held (R-L7, G-17). */
const HELD_LINE: Record<HeldReason, string> = {
  user: `เดือนนี้ LINE แจ้งเตือนคุณครบ ${LINE.perUserMonth} ครั้งแล้ว`,
  system: 'โควตา LINE ของระบบเดือนนี้เหลือน้อย — ส่งได้เฉพาะระดับอันตราย',
  exhausted: 'เดือนนี้ LINE ของระบบส่งแจ้งเตือนไม่ได้แล้ว',
};
export const lineHeldLine = (reason: HeldReason): string => `${HELD_LINE[reason]} — ระดับตอนนี้:`;
const HELD_LIST: Record<HeldReason, string> = {
  user: `เดือนนี้ LINE แจ้งเตือนคุณครบ ${LINE.perUserMonth} ครั้งแล้ว — ระดับเตือนภัยและการเลิกเตือนที่เหลือจะไม่ส่งทาง LINE ดูระดับบนเว็บหรือส่งตำแหน่งมาถาม`,
  system: 'โควตา LINE ของระบบเดือนนี้เหลือน้อย — อาจส่งได้เฉพาะระดับอันตราย ระดับอื่นจะไม่ส่งทาง LINE ดูระดับบนเว็บหรือส่งตำแหน่งมาถาม',
  exhausted: 'เดือนนี้ LINE ของระบบส่งแจ้งเตือนไม่ได้แล้ว (รวมระดับอันตราย) — ดูระดับบนเว็บหรือส่งตำแหน่งมาถาม และเปิด Telegram หรือ Web Push',
};

export function lineListText(rows: readonly { label: string; key: string }[], sent: number, held: HeldReason | null): string {
  const lines = ['จุดที่ติดตาม:', ...rows.map((r, i) => `${i + 1}. ${r.label} (${r.key.replace(',', ', ')})`), `LINE แจ้งเตือนคุณเดือนนี้ ${sent}/${LINE.perUserMonth} ครั้ง`];
  if (held !== null) lines.push(HELD_LIST[held]);
  return lines.join('\n');
}

export function lineHelpText(siteUrl: string): string {
  return [
    `วิธีใช้: ส่งตำแหน่ง → ดูระดับของจุดนั้น (ทุกคน) · ผู้ที่แอดมินอนุมัติแล้วแตะ "ติดตามจุดนี้" ได้ไม่เกิน ${LINE.placesPerUser} จุด`,
    '• มือถือ: แตะ "ส่งตำแหน่ง" ด้านล่าง หรือ + → ตำแหน่ง → เลื่อนหมุดหรือค้นหาสถานที่ → แชร์',
    '• คอมพิวเตอร์: พิมพ์พิกัด (ทศนิยม 3 ตำแหน่งขึ้นไป) เช่น 13.681, 102.084 หรือวางลิงก์ Google Maps แบบเต็ม (ลิงก์ย่อ maps.app.goo.gl ใช้ไม่ได้)',
    `แจ้งเตือนเมื่อจุดที่ติดตามถึงระดับ "${LEVEL_TH[ALERT.level as Level]}" ขึ้นไป และเมื่อต่ำกว่านั้นต่อเนื่อง 1 ชม. · ${LINE_LIMIT_NOTE_TH}`,
    'ข้อมูลหาย = บอทเงียบ ไม่ได้แปลว่าปลอดภัย',
    `พิมพ์ "${LINE_CMD.request}" ขอสิทธิ์ · "${LINE_CMD.list}" จุดที่ติดตาม · "${LINE_CMD.stop}" ลบทั้งหมด`,
    `${LINE_PRIVACY_TH} (สำเนาสำรองลบภายใน 14 วัน)`,
    NOT_A_REPORT_TH,
    `ดูบนเว็บ: ${siteUrl}`,
    NO_OFFICIAL_ORDER,
  ].join('\n');
}
/** LINE_OFF=1 (G-5). */
export const lineOffText = (siteUrl: string): string => `LINE ของระบบแจ้งเตือนปิดชั่วคราว — ดูบนเว็บ: ${siteUrl}\n${NOT_A_REPORT_TH}`;

/* ---- the admin, in Telegram ---- */
export const LINE_APPROVE_BUTTON_TH = 'อนุมัติ';
export const LINE_REJECT_BUTTON_TH = 'ปฏิเสธ';
export const lineRevokeButtonText = (id: number): string => `ถอนสิทธิ์ #${id}`;
/** /line_users buttons for a pending person (a lost request notice must never strand a request). */
export const lineApproveButtonText = (id: number): string => `${LINE_APPROVE_BUTTON_TH} #${id}`;
export const lineRejectButtonText = (id: number): string => `${LINE_REJECT_BUTTON_TH} #${id}`;
/** The display name comes from LINE's Get profile at that moment and is never stored (spec §4.2, R-L9). */
export function lineRequestAdminText(o: { id: number; name: string | null; approved: number; used: number; limit: number }): string {
  const name = cleanText(o.name ?? '', 40) || '(ดูชื่อไม่ได้)';
  return `คำขอ LINE #${o.id}: ${name}\nอนุมัติแล้ว ${o.approved}/${LINE.maxApproved} · โควตาเดือนนี้ใช้ ${o.used}/${o.limit}`;
}
export const ADMIN_LINKED_TH = 'ผูกบัญชีนี้เป็นแอดมิน LINE แล้ว — คำขอใหม่จะส่งมาที่นี่ · /line ยอดโควตา · /line_users รายชื่อ';
const WELCOME_NOTE: Record<'sent' | 'held' | 'failed' | 'off', string> = {
  sent: 'ส่งข้อความต้อนรับแล้ว',
  held: 'ไม่ได้ส่งข้อความต้อนรับ (งบ LINE ไม่พอ) — ผู้ใช้เห็นสถานะเมื่อทักมา',
  failed: 'ส่งข้อความต้อนรับไม่สำเร็จ — ผู้ใช้เห็นสถานะเมื่อทักมา',
  off: 'ไม่ได้ส่งข้อความต้อนรับ (ระบบหยุดชั่วคราวหรือปิด LINE)',
};
export const lineApprovedAdminText = (id: number, welcome: 'sent' | 'held' | 'failed' | 'off'): string => `อนุมัติ #${id} แล้ว · ${WELCOME_NOTE[welcome]}`;
export const LINE_FULL_ADMIN_TH = `อนุมัติครบ ${LINE.maxApproved} คนแล้ว — ถอนสิทธิ์บางคนก่อน (/line_users)`;
export const lineRejectedAdminText = (id: number): string => `ปฏิเสธ #${id} แล้ว (ผู้ใช้เห็นเมื่อทักมา)`;
export const LINE_DECIDED_ADMIN_TH = 'คำขอนี้ถูกตัดสินไปแล้วหรือไม่มีแล้ว — ไม่ได้เปลี่ยนอะไร';
export const lineRevokedAdminText = (id: number): string => `ถอนสิทธิ์ #${id} แล้ว (ลบจุดที่ติดตามของเขา)`;
export function lineStatusAdminText(o: { ours: number; lineTotal: number | null; limit: number; approved: number; pending: number; held: number; exhausted: boolean }): string {
  const lines = [
    `LINE เดือนนี้: ใช้ ${o.ours} (LINE รายงาน ${o.lineTotal ?? '—'}) / ${o.limit} · กันไว้ ${LINE.reserve} สำหรับระดับอันตรายและข้อความต้อนรับ`,
    `อนุมัติ ${o.approved}/${LINE.maxApproved} · รอ ${o.pending} คน · ระงับเดือนนี้ ${o.held} ครั้ง (นับทุกรอบ)`,
  ];
  if (o.exhausted) lines.push('LINE ตอบ 429 เดือนนี้ — หยุดส่ง LINE ทั้งหมด จนกว่ายอดที่ LINE รายงานจะต่ำกว่าเพดาน');
  return lines.join('\n');
}
const STATE_TH: Record<LineState, string> = { pending: 'รอ', approved: 'อนุมัติ', rejected: 'ปฏิเสธ' };
export function lineUsersAdminText(rows: readonly { id: number; state: LineState; places: number; sent: number }[]): string {
  if (!rows.length) return 'ยังไม่มีผู้ใช้ LINE';
  return ['ผู้ใช้ LINE:', ...rows.map((r) => `#${r.id} ${STATE_TH[r.state]} จุด ${r.places} ส่งเดือนนี้ ${r.sent}`)].join('\n');
}
export const lineHeldAdminText = (held: number): string => `LINE: มีการแจ้งเตือนถูกระงับเพราะงบ (เดือนนี้ ${held} ครั้ง นับทุกรอบ) — /line`;
export const lineLowAdminText = (used: number, limit: number): string => `LINE: โควตาเดือนนี้เหลือ ${Math.max(0, limit - used)} จาก ${limit} (≤ ${LINE.reserve}) — ต่อจากนี้ส่งเฉพาะระดับอันตราย`;
export const LINE_AUTH_ADMIN_TH = 'LINE ตอบ 401/403 — channel access token ผิดหรือถูกยกเลิก: ออกใหม่แล้วรัน thuammai line token (docs/ops/line-owner-setup.md)';
export const LINE_EXHAUSTED_ADMIN_TH = 'LINE ตอบ 429 (โควตาเดือนนี้หมด) — หยุดส่ง LINE จนกว่ายอดที่ LINE รายงานจะต่ำกว่าเพดาน (ปกติคือถึงสิ้นเดือน) · /line';
