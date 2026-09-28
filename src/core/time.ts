import { FUTURE_TOLERANCE_MIN } from './thresholds';

const OFFSET_MS = 7 * 3600_000;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH:mm[:ss]" in Asia/Bangkok (no offset in the string). Fractional seconds are ignored. */
export function parseLocal(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = LOCAL_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;

  const yNum = Number(y);
  const moNum = Number(mo);
  const dNum = Number(d);
  const hNum = Number(h);
  const miNum = Number(mi);
  const seNum = se ? Number(se) : 0;

  // Basic range checks
  if (moNum < 1 || moNum > 12 || hNum < 0 || hNum > 23 || miNum < 0 || miNum > 59 || seNum < 0 || seNum > 59) {
    return null;
  }

  // Check day is valid (at least 1 and at most 31)
  if (dNum < 1 || dNum > 31) {
    return null;
  }

  const ms = Date.UTC(yNum, moNum - 1, dNum, hNum, miNum, seNum) - OFFSET_MS;
  const result = new Date(ms);

  if (Number.isNaN(result.getTime())) {
    return null;
  }

  // Round-trip validation: convert back to Bangkok local time and verify fields match
  const bangkokDate = new Date(result.getTime() + OFFSET_MS);
  const resultY = bangkokDate.getUTCFullYear();
  const resultMo = bangkokDate.getUTCMonth() + 1;
  const resultD = bangkokDate.getUTCDate();
  const resultH = bangkokDate.getUTCHours();
  const resultMi = bangkokDate.getUTCMinutes();
  const resultSe = bangkokDate.getUTCSeconds();

  if (resultY === yNum && resultMo === moNum && resultD === dNum && resultH === hNum && resultMi === miNum && resultSe === seNum) {
    return result;
  }

  return null;
}

/** Traffy style "2026-09-28 07:32:57.362437+00" (UTC). */
export function parseUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = s.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/\+00(:?00)?$/, 'Z');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toIso07(d: Date): string {
  return new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 19) + '+07:00';
}

export function ageMin(t: string | Date, now: Date): number {
  const ms = typeof t === 'string' ? Date.parse(t) : t.getTime();
  return (now.getTime() - ms) / 60_000;
}

export function isTooFarInFuture(d: Date, now: Date): boolean {
  return d.getTime() - now.getTime() > FUTURE_TOLERANCE_MIN * 60_000;
}

function bangkokParts(iso: string) {
  const d = new Date(Date.parse(iso) + OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

export function fmtTime(iso: string): string {
  const p = bangkokParts(iso);
  return `${pad(p.h)}:${pad(p.mi)} น.`;
}

export function fmtDateTime(iso: string): string {
  const p = bangkokParts(iso);
  return `${p.d} ${TH_MONTHS[p.m]} ${p.y + 543} ${pad(p.h)}:${pad(p.mi)} น.`;
}
