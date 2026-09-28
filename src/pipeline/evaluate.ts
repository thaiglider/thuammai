// Daily skill evaluation (evaluate.yml): replay yesterday's hourly snapshots from the pipeline state,
// keep per-day tallies (tallies.json), and publish 7/30-day skill (skill.json) + a gzip archive.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { LEVEL_KEYS, SIGNAL_SETS, SKILL_MAX_BYTES, TRUTHS, type SkillEvidence, type SkillFile, type SkillMetric, type SkillWindow, type Truth } from '../core/skill';
import { addTallySet, emptyTallySet, mapTallySet, ratios, type Tally, type TallySet } from '../core/skill-score';
import { EVAL, SKILL_TARGET, THRESHOLDS_VERSION } from '../core/thresholds';
import { toIso07 } from '../core/time';
import { currentEvalLog, emptyEvalLog, isEvalLog } from './eval-log';
import { emptyUnitSets, evaluateDay, type DayUnits } from './score';
import { loadState } from './state';

const DAY_MS = 86400e3;
const OFFSET_MS = 7 * 3600e3;

/** `units` = the distinct reports/sensors/places behind the tallies; absent in days written before it
 *  existed, which then add no independent evidence (their ratios stay "not enough data"). */
export interface DayTally { day: string; snaps: number; thresholdsVersion: string; tallies: TallySet; units?: DayUnits }
export interface TallyFile { v: 1; days: DayTally[] }
export const emptyTallyFile = (): TallyFile => ({ v: 1, days: [] });

const isStrings = (x: unknown): boolean => Array.isArray(x) && x.every((v) => typeof v === 'string');

function isDayUnits(u: unknown): boolean {
  const x = u as DayUnits | null;
  return !!x && typeof x === 'object' && TRUTHS.every((t) => isStrings(x.truth?.[t])
    && SIGNAL_SETS.every((s) => LEVEL_KEYS.every((k) => isStrings(x.flag?.[t]?.[s]?.[k]))));
}

export function isTallyFile(x: unknown): x is TallyFile {
  const f = x as TallyFile | null;
  return !!f && typeof f === 'object' && f.v === 1 && Array.isArray(f.days) && f.days.every((d) =>
    !!d && typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && typeof d.snaps === 'number'
    && typeof d.thresholdsVersion === 'string' && !!d.tallies && typeof d.tallies === 'object'
    && (d.units === undefined || isDayUnits(d.units))
    && TRUTHS.every((t) => SIGNAL_SETS.every((s) => LEVEL_KEYS.every((k) => {
      const c = d.tallies[t]?.[s]?.[k];
      return !!c && [c.hD, c.hN, c.pD, c.pN, c.bD, c.bN].every((n) => typeof n === 'number');
    }))));
}

/** Lenient read: a missing, unreadable or foreign file is empty tallies. With `required` (a previous
 *  archive Release exists, so the file IS the running record) anything but a valid file throws. */
export function readTallies(path: string | undefined, required = false): TallyFile {
  if (required) {
    if (!path || !existsSync(path)) throw new Error(`tallies file is required but missing: ${path ?? '(none)'}`);
    const x: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isTallyFile(x)) throw new Error(`tallies file is required but not a valid tallies file: ${path}`);
    return x;
  }
  if (!path || !existsSync(path)) return emptyTallyFile();
  try {
    const x = JSON.parse(readFileSync(path, 'utf8'));
    return isTallyFile(x) ? x : emptyTallyFile();
  } catch {
    return emptyTallyFile();
  }
}

/** Calendar day in Asia/Bangkok, "YYYY-MM-DD". */
export const bangkokDay = (ms: number): string => new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
/** [start, end) epoch ms of a Bangkok calendar day. */
export function dayRange(day: string): [number, number] {
  const start = Date.parse(`${day}T00:00:00+07:00`);
  return [start, start + DAY_MS];
}
export const addDays = (day: string, n: number): string => bangkokDay(dayRange(day)[0] + n * DAY_MS);

/** Keeps the EVAL.tallyDays days before `today`, sorted. */
export function pruneDays(file: TallyFile, today: string): TallyFile {
  const first = addDays(today, -EVAL.tallyDays);
  return { v: 1, days: file.days.filter((d) => d.day >= first && d.day < today).sort((a, b) => a.day.localeCompare(b.day)) };
}

/** Inserts or replaces one day. A same-thresholds recomputation from fewer snapshots (older ones
 *  already pruned from the state) never replaces a fuller result. */
export function upsertDay(file: TallyFile, d: DayTally, today: string): TallyFile {
  const old = file.days.find((x) => x.day === d.day);
  const keepOld = !!old && old.thresholdsVersion === d.thresholdsVersion && old.snaps > d.snaps;
  const days = file.days.filter((x) => x.day !== d.day);
  days.push(keepOld ? old! : d);
  return pruneDays({ v: 1, days }, today);
}

const round = (x: number | null, digits: number) => (x === null ? null : Math.round(x * 10 ** digits) / 10 ** digits);

/** Independent evidence behind one cell: distinct truth units/days (hit), distinct warned places/days (prec). */
export interface CellEvidence { truth: SkillEvidence; flagUnits: number; flagDays: number }

/** Ratios need ≥minN samples AND enough independent evidence (EVAL.minDays, minTruthUnits,
 *  minFlagUnits) — hourly samples of one storm are not independent cases. */
export function metricOf(t: Tally, truth: Truth, ev: CellEvidence, minN: number = EVAL.minN): SkillMetric {
  const r = ratios(t, minN);
  const hitOk = ev.truth.units >= EVAL.minTruthUnits[truth] && ev.truth.days >= EVAL.minDays;
  const flagOk = ev.flagUnits >= EVAL.minFlagUnits[truth] && ev.flagDays >= EVAL.minDays;
  return {
    hit: hitOk ? round(r.hit, 3) : null, prec: flagOk ? round(r.prec, 3) : null, lift: flagOk ? round(r.lift, 2) : null,
    nHit: t.hD, nFlag: t.pD, uFlag: ev.flagUnits, dFlag: ev.flagDays,
  };
}

export function windowMetrics(file: TallyFile, lastDay: string, nDays: number, version: string = THRESHOLDS_VERSION): SkillWindow {
  const first = addDays(lastDay, -(nDays - 1));
  const days = file.days.filter((d) => d.day >= first && d.day <= lastDay && d.thresholdsVersion === version);
  const acc = emptyTallySet();
  const units = emptyUnitSets();
  const truthDays = { reports: 0, road: 0 };
  const flagDays = mapTallySet(emptyTallySet(), () => 0);
  for (const d of days) {
    addTallySet(acc, d.tallies);
    for (const t of TRUTHS) {
      // truth instances are the same for every signal set and level
      if (d.tallies[t].all['2'].hD > 0) truthDays[t]++;
      for (const id of d.units?.truth[t] ?? []) units.truth[t].add(id);
      for (const g of SIGNAL_SETS) for (const k of LEVEL_KEYS) {
        if (d.tallies[t][g][k].pD > 0) flagDays[t][g][k]++;
        for (const id of d.units?.flag[t][g][k] ?? []) units.flag[t][g][k].add(id);
      }
    }
  }
  const evidence = {
    reports: { units: units.truth.reports.size, days: truthDays.reports },
    road: { units: units.truth.road.size, days: truthDays.road },
  };
  const truths = mapTallySet(emptyTallySet(), () => null as unknown as SkillMetric);
  for (const t of TRUTHS) for (const g of SIGNAL_SETS) for (const k of LEVEL_KEYS)
    truths[t][g][k] = metricOf(acc[t][g][k], t, { truth: evidence[t], flagUnits: units.flag[t][g][k].size, flagDays: flagDays[t][g][k] });
  return {
    days: days.length, snaps: days.reduce((n, d) => n + d.snaps, 0),
    from: days[0]?.day ?? null, to: days.at(-1)?.day ?? null,
    evidence, truths,
  };
}

export function buildSkill(file: TallyFile, now: Date): SkillFile {
  const lastDay = addDays(bangkokDay(now.getTime()), -1);
  return {
    kind: 'skill', schema: 1, generatedAt: toIso07(now), thresholdsVersion: THRESHOLDS_VERSION, minN: EVAL.minN,
    target: { ...SKILL_TARGET },
    windows: { '7': windowMetrics(file, lastDay, 7), '30': windowMetrics(file, lastDay, 30) },
  };
}

export interface EvaluateOpts { state: string; site?: string; tallies?: string; requireTallies?: boolean; out: string; now?: string; fetchImpl?: typeof fetch }
export interface EvaluateResult { skill: SkillFile; evaluated: string[]; archive: string; tag: string }

export async function runEvaluate(o: EvaluateOpts): Promise<EvaluateResult> {
  const now = o.now ? new Date(o.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid --now: ${o.now}`);
  const previous = readTallies(o.tallies, o.requireTallies); // before any work: a required record that is missing fails fast
  const st = await loadState(o.state, o.site, o.fetchImpl);
  // Only snapshots recorded under the current thresholds are scored (plan ruling 5); the archive keeps
  // whatever log the state had, so nothing is lost.
  const rawLog = isEvalLog(st.evalLog) ? st.evalLog : emptyEvalLog();
  const log = currentEvalLog(rawLog) ?? emptyEvalLog();
  const today = bangkokDay(now.getTime());
  const yesterday = addDays(today, -1);
  let file = pruneDays(previous, today);
  const evaluated: string[] = [];
  for (const back of [2, 1]) {
    const day = addDays(today, -back);
    // The day before yesterday is only a backfill for a missed run; yesterday is always recomputed.
    if (back === 2 && file.days.some((d) => d.day === day && d.thresholdsVersion === THRESHOLDS_VERSION)) continue;
    const [from, to] = dayRange(day);
    const r = evaluateDay(log, st.history.events, st.history.series, from, to);
    if (r.snaps === 0) continue;
    file = upsertDay(file, { day, snaps: r.snaps, thresholdsVersion: THRESHOLDS_VERSION, tallies: r.tallies, units: r.units }, today);
    evaluated.push(day);
  }
  const skill = buildSkill(file, now);
  const text = JSON.stringify(skill);
  if (text.length > SKILL_MAX_BYTES) throw new Error(`skill.json is ${text.length} bytes (max ${SKILL_MAX_BYTES})`);
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, 'skill.json'), text);
  writeFileSync(join(o.out, 'tallies.json'), JSON.stringify(file));
  const archive = `archive-${yesterday}.json.gz`;
  writeFileSync(join(o.out, archive), gzipSync(JSON.stringify({
    generatedAt: toIso07(now), schema: 1, thresholdsVersion: THRESHOLDS_VERSION, day: yesterday,
    stateSavedAt: st.savedAt, history: st.history, evalLog: rawLog,
  })));
  return { skill, evaluated, archive, tag: `archive-${yesterday.slice(0, 7)}` };
}

async function cli() {
  const { values } = parseArgs({
    options: {
      state: { type: 'string', default: '.cache/state.json' },
      site: { type: 'string' },
      tallies: { type: 'string' },
      'require-tallies': { type: 'boolean', default: false },
      out: { type: 'string', default: '.cache/eval-out' },
      'tag-file': { type: 'string' },
      now: { type: 'string' },
    },
  });
  const r = await runEvaluate({ state: values.state!, site: values.site, tallies: values.tallies, requireTallies: values['require-tallies'], out: values.out!, now: values.now });
  if (values['tag-file']) writeFileSync(values['tag-file'], r.tag);
  console.log(`evaluated days: ${r.evaluated.length ? r.evaluated.join(', ') : 'none (no snapshots in range)'}`);
  for (const w of ['7', '30'] as const) {
    for (const t of TRUTHS) {
      const m = r.skill.windows[w].truths[t].all['3'];
      const e = r.skill.windows[w].evidence[t];
      console.log(`${w}d ${t.padEnd(7)} level≥3: hit=${m.hit ?? '-'} (n=${m.nHit}, ${e.units} units/${e.days} days) precision=${m.prec ?? '-'} (n=${m.nFlag}, ${m.uFlag} places/${m.dFlag} days) lift=${m.lift ?? '-'}`);
    }
  }
  console.log(`wrote skill.json, tallies.json, ${r.archive} to ${values.out} (release ${r.tag})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
