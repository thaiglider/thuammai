// Shape of data/skill.json (written by evaluate.yml, published by the pipeline, read by the web app).

export const TRUTHS = ['reports', 'road'] as const;
export type Truth = (typeof TRUTHS)[number];
/** 'all' = every instrument together (no reports, no forecast — NOT the full level the app shows);
 *  the rest = one station kind alone. */
export const SIGNAL_SETS = ['all', 'road', 'canal', 'river', 'rain'] as const;
export type SignalSet = (typeof SIGNAL_SETS)[number];
export const LEVEL_KEYS = ['2', '3'] as const;
export type LevelKey = (typeof LEVEL_KEYS)[number];
export type Matrix<T> = Record<Truth, Record<SignalSet, Record<LevelKey, T>>>;

/** Ratios are null when their sample is below `minN` OR it rests on too little independent evidence
 *  (EVAL.minDays / minTruthUnits / minFlagUnits); the counts are always given. Samples are counted
 *  per hourly snapshot, so nHit/nFlag are unit×hour counts, not independent cases. */
export interface SkillMetric {
  hit: number | null;   // share of truth instances assessed ≥ level
  prec: number | null;  // share of warnings (≥ level) that were true
  lift: number | null;  // prec ÷ base rate
  nHit: number;         // truth instances × hours (denominator of hit)
  nFlag: number;        // warnings × hours (denominator of prec)
  uFlag: number;        // distinct warned places (0.01° grid points for reports, sensors for road)
  dFlag: number;        // distinct days with ≥1 warning
}
/** Independent evidence behind every hit rate of one truth (the same for all signal sets and levels):
 *  distinct reports (reports) or wet sensors (road), and distinct days with any. */
export interface SkillEvidence { units: number; days: number }
export interface SkillWindow {
  days: number; snaps: number; from: string | null; to: string | null;
  evidence: Record<Truth, SkillEvidence>;
  truths: Matrix<SkillMetric>;
}
export interface SkillFile {
  kind: 'skill'; schema: 1; generatedAt: string; thresholdsVersion: string; minN: number;
  target: { level: number; precision: number; hit: number };
  windows: { '7': SkillWindow; '30': SkillWindow };
}

export const SKILL_MAX_BYTES = 5000;

const numOrNull = (x: unknown) => x === null || typeof x === 'number';

export function isSkillFile(x: unknown): x is SkillFile {
  const s = x as SkillFile | null;
  if (!s || typeof s !== 'object' || s.kind !== 'skill' || s.schema !== 1) return false;
  if (typeof s.generatedAt !== 'string' || typeof s.thresholdsVersion !== 'string' || typeof s.minN !== 'number') return false;
  if (!s.target || typeof s.target.level !== 'number' || typeof s.target.precision !== 'number' || typeof s.target.hit !== 'number') return false;
  return (['7', '30'] as const).every((w) => {
    const win = s.windows?.[w];
    return !!win && typeof win.days === 'number' && typeof win.snaps === 'number'
      && (win.to === null || typeof win.to === 'string')
      && TRUTHS.every((t) => typeof win.evidence?.[t]?.units === 'number' && typeof win.evidence[t].days === 'number')
      && TRUTHS.every((t) => SIGNAL_SETS.every((g) => LEVEL_KEYS.every((k) => {
        const m = win.truths?.[t]?.[g]?.[k];
        return !!m && typeof m.nHit === 'number' && typeof m.nFlag === 'number' && typeof m.uFlag === 'number' && typeof m.dFlag === 'number'
          && numOrNull(m.hit) && numOrNull(m.prec) && numOrNull(m.lift);
      })));
  });
}
