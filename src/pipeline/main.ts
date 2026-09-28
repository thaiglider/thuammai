import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { appendEvents, appendSamples, compact } from '../core/history';
import { computeStatus } from '../core/station';
import { FRESH_MIN, HELD_MAX_H, HISTORY } from '../core/thresholds';
import { ageMin, toIso07 } from '../core/time';
import type { Observation, RawObs, SourceHealth } from '../core/types';
import { collectAll, type Collected } from './collect';
import { currentEvalLog, emptyEvalLog, pruneEvalLog, recordSnapshot } from './eval-log';
import { fixtureFetcher, liveFetcher, type Fetcher } from './fetcher';
import { buildOutputs } from './publish';
import { loadSkill } from './skill-input';
import { emptyState, loadState, saveState, type PipelineState } from './state';
import { loadStaticData } from './static-data';

export interface RunOpts {
  out: string; fixtures?: string; now?: string; state: string; site?: string; freshState?: boolean;
  /** Overrides the fetcher chosen from `fixtures` (tests). */
  fetcher?: Fetcher;
  /** Path of skill.json downloaded from the newest archive Release (optional). */
  skill?: string;
}

/** Refuse to write into a directory that is the filesystem root, the user's home, the
 *  current working directory, or an ancestor of it. The pipeline only ever replaces its
 *  own `data/` and `p/` subdirectories, so an app build elsewhere under `out` is safe. */
function assertSafeOutDir(out: string): void {
  const resolved = resolve(out);
  const cwd = resolve(process.cwd());
  const home = resolve(homedir());
  const root = parse(resolved).root;
  if (resolved === root || resolved === home || resolved === cwd || cwd.startsWith(resolved + sep)) {
    throw new Error(`Refusing to write into unsafe output directory: ${resolved}`);
  }
}

export interface RunResult { files: number; health: SourceHealth[]; obs: Observation[]; collected: Collected }

export async function runPipeline(opts: RunOpts): Promise<RunResult> {
  const now = opts.now ? new Date(opts.now) : new Date();
  if (opts.now && Number.isNaN(now.getTime())) throw new Error(`Invalid --now: ${opts.now}`);
  assertSafeOutDir(opts.out);

  const sd = loadStaticData();
  const st = opts.freshState ? emptyState() : await loadState(opts.state, opts.site);
  const fetcher = opts.fetcher ?? (opts.fixtures ? fixtureFetcher(opts.fixtures) : liveFetcher());
  const sleep = opts.fixtures || opts.fetcher ? async () => {} : undefined;

  const c = await collectAll(fetcher, st, now, sd, sleep);
  const raws = [...c.river, ...c.rain, ...c.road, ...c.canal, ...c.dam];

  // historyH is measured from wall-clock time elapsed across pipeline runs, not from raw
  // sample timestamps: some stations legitimately report readings many hours old, and a
  // single such reading persisting in `history.series` would otherwise make historyH look
  // large forever (across every future run), wrongly enabling rise/stuck/erratic rules.
  // `historySince` marks the start of the current unbroken run of invocations; it resets
  // whenever the state is fresh, has never been saved, or the gap since the last run is
  // large enough that continuity can't be assumed (>1 h, e.g. after an outage or a manual restart).
  const nowMs = now.getTime();
  const gapMs = st.savedAt ? nowMs - Date.parse(st.savedAt) : Infinity;
  if (!st.historySince || !st.savedAt || gapMs > 60 * 60e3) st.historySince = toIso07(now);
  const historyH = Math.min(HISTORY.keepH, (nowMs - Date.parse(st.historySince)) / 3600e3);

  appendSamples(st.history, raws);
  appendEvents(st.history, [...c.longdo, ...c.traffy]);
  compact(st.history, nowMs);
  const { held, missing } = reinstateMissing(st, raws, nowMs);
  const obs = computeStatus([...raws, ...held], { now, history: st.history, historyH, missing });
  rememberLastSeen(st, raws, obs, now);

  // A malformed log, or one recorded under other thresholds, restarts (levels are rule-specific).
  st.evalLog = currentEvalLog(st.evalLog) ?? emptyEvalLog();
  recordSnapshot(st.evalLog, obs, nowMs);
  pruneEvalLog(st.evalLog, nowMs);

  st.savedAt = now.toISOString();
  const skill = await loadSkill(opts.skill, opts.site);
  const files = buildOutputs({ now, obs, collected: c, sd, history: st.history, historyH, state: st, skill });
  for (const sub of ['data', 'p']) rmSync(join(opts.out, sub), { recursive: true, force: true });
  for (const [rel, content] of files) {
    const full = join(opts.out, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  saveState(opts.state, st);
  return { files: files.size, health: c.health, obs, collected: c };
}

/** Stations whose last fresh level was ≥3 (within HELD_MAX_H) but which are absent from the
 *  current feed: re-supply their last fresh reading so computeStatus can hold them. */
function reinstateMissing(st: PipelineState, raws: RawObs[], nowMs: number): { held: RawObs[]; missing: Set<string> } {
  const present = new Set(raws.map((r) => r.id));
  const held: RawObs[] = [];
  const missing = new Set<string>();
  for (const [id, last] of Object.entries(st.history.lastLevel)) {
    if (last.level < 3 || present.has(id) || nowMs - Date.parse(last.t) > HELD_MAX_H * 3600e3) continue;
    const r = st.lastSeen?.[id];
    if (!r) continue;
    held.push(r);
    missing.add(id);
  }
  return { held, missing };
}

function rememberLastSeen(st: PipelineState, raws: RawObs[], obs: Observation[], now: Date): void {
  const seen = (st.lastSeen ??= {});
  const rawById = new Map(raws.map((r) => [r.id, r]));
  for (const o of obs) {
    const r = rawById.get(o.id);
    if (!r || o.level < 3 || o.held || ageMin(r.t, now) > FRESH_MIN[r.kind]) continue;
    seen[o.id] = r;
  }
  for (const id of Object.keys(seen)) {
    const last = st.history.lastLevel[id];
    if (!last || now.getTime() - Date.parse(last.t) > HELD_MAX_H * 3600e3) delete seen[id];
  }
}

async function cli() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'dist' },
      fixtures: { type: 'string' },
      now: { type: 'string' },
      state: { type: 'string', default: '.cache/state.json' },
      site: { type: 'string' },
      'fresh-state': { type: 'boolean', default: false },
      skill: { type: 'string' },
    },
  });
  const r = await runPipeline({
    out: values.out!, fixtures: values.fixtures, now: values.now, state: values.state!,
    site: values.site, freshState: values['fresh-state'], skill: values.skill,
  });
  for (const h of r.health) {
    console.log(`${h.ok ? 'OK ' : 'ERR'} ${h.id.padEnd(8)} n=${String(h.count).padStart(5)} lag=${h.lagMin ?? '-'}m${h.error ? ` ${h.error}` : ''}${h.carriedFrom ? ` (carried from ${h.carriedFrom})` : ''}`);
  }
  console.log(`wrote ${r.files} files to ${values.out}`);
  try {
    const stateFileSize = statSync(join(values.out!, 'data', '_state.json')).size;
    console.log(`data/_state.json: ${stateFileSize} bytes`);
  } catch { /* not fatal — just an informational line */ }
  if (r.health.every((h) => !h.ok)) process.exit(2); // total outage → do not deploy
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
