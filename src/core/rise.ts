import { RISE, ROAD } from './thresholds';

export interface Sample { t: number; v: number }
const M = 60e3;
const H = 3600e3;

export function removeDropouts(s: Sample[]): Sample[] {
  if (s.length < 3) return s.slice();
  const out: Sample[] = [s[0]!];
  for (let i = 1; i < s.length - 1; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    const c = s[i + 1]!;
    const spike = Math.abs(b.v - a.v) >= RISE.dropoutStep && Math.abs(b.v - c.v) >= RISE.dropoutStep
      && Math.abs(c.v - a.v) <= RISE.dropoutReturn;
    if (!spike) out.push(b);
  }
  out.push(s[s.length - 1]!);
  return out;
}

export function isErratic(s: Sample[], nowMs: number): boolean {
  const w = s.filter((x) => x.t >= nowMs - RISE.erraticWindowMin * M);
  let steps = 0;
  for (let i = 1; i < w.length; i++) if (Math.abs(w[i]!.v - w[i - 1]!.v) >= RISE.erraticStep) steps++;
  return steps >= RISE.erraticCount;
}

export function isStuck(s: Sample[], nowMs: number): boolean {
  const from = nowMs - ROAD.stuckHours * H;
  const w = s.filter((x) => x.t >= from - 30 * M);
  if (w.length < 3 || w[0]!.t > from + 30 * M) return false;
  const v0 = w[0]!.v;
  return v0 !== 0 && w.every((x) => x.v === v0);
}

export function slope(s: Sample[], nowMs: number): { perHour: number; r2: number } | null {
  const w = s.filter((x) => x.t >= nowMs - RISE.windowH * H);
  if (w.length < RISE.minPoints) return null;
  const xs = w.map((x) => (x.t - w[0]!.t) / H);
  const ys = w.map((x) => x.v);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  if (syy === 0) return { perHour: 0, r2: 1 };
  const r2 = (sxy * sxy) / (sxx * syy);
  if (r2 < RISE.minR2) return null;
  return { perHour: sxy / sxx, r2 };
}

export function r3h(s: Sample[]): number | null {
  if (!s.length) return null;
  const anchor = s[s.length - 1]!.t;
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const target = anchor - k * H;
    let best: Sample | undefined;
    let bestD = Infinity;
    for (const x of s) {
      const d = Math.abs(x.t - target);
      if (d < bestD) { bestD = d; best = x; }
    }
    if (!best || bestD > 15 * M) return null;
    sum += best.v;
  }
  return sum;
}
