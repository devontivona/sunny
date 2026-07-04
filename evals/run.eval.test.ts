import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, envRunConfig, runEvalCase } from './harness.js';
import { loadCases } from './cases/index.js';
import { BudgetExceededError, CostMeter, estimateCostUsd } from './cost.js';
import {
  DEFAULT_THRESHOLD,
  casePassed,
  cellSlug,
  diffScorecards,
  summarizeDimensions,
  type CaseScore,
  type Scorecard,
  type ScorecardConfig,
} from './scorecard.js';
import { historyTier, type Dimension, type GradeResult } from './types.js';
import type { SunnyConfig } from '../src/config/index.js';

/**
 * `npm run eval` entrypoint (task 7.8) — runs as ONE Vitest test under the workflow plugin
 * (`vitest.eval.config.ts`) so it can drive the durable turn. Selects a dimension/model/N, runs
 * each case N times, scores by pass rate (D8), enforces a hard cost cap (7.7), writes a file-based
 * scorecard, and FAILS the test on a regression vs the committed baseline (D10) — so `npm run eval`
 * still exits non-zero on a regression.
 *
 * Off the merge gate by construction (its own config; needs a real API key). Options come from env
 * (vitest owns argv): EVAL_DIMENSION / EVAL_MODEL / EVAL_N / EVAL_COST_CAP_USD.
 */
/** A single case-run exceeded the watchdog (a hung model stream / parked run must
 *  cost one failed run, never the whole scorecard). */
class RunTimeoutError extends Error {
  constructor(ms: number) {
    super(`case run exceeded EVAL_RUN_TIMEOUT_MS (${ms}ms)`);
  }
}

interface Options {
  dimension: Dimension | 'all';
  model: string;
  n: number;
  costCapUsd: number;
  /** Per-run watchdog. A 2026-07-03 N=5 run sat 73 min behind ONE hung turn. */
  runTimeoutMs: number;
  /** Optional case-name regex (EVAL_CASES) — e.g. exclude the 8-min-per-run
   *  real-batches fixture from a quick screening cell. */
  caseFilter?: RegExp;
  /** Non-default knobs forced for this run (a grid cell). Empty env = config default. */
  cell?: ScorecardConfig;
  /** The `SunnyConfig` overrides `cell` translates to, passed into every case run. */
  runConfig: Partial<SunnyConfig>;
}

function parseOptions(): Options {
  const runConfig = envRunConfig();
  const cell: ScorecardConfig = {};
  if (runConfig.thinking) cell.thinking = runConfig.thinking;
  if (runConfig.effort) cell.effort = runConfig.effort;
  if (runConfig.promptVariant) cell.promptVariant = runConfig.promptVariant;
  if (runConfig.inboundEnvelope !== undefined) cell.inboundEnvelope = runConfig.inboundEnvelope;
  if (runConfig.fewshot !== undefined) cell.fewshot = runConfig.fewshot;
  if (runConfig.composerAlways !== undefined) cell.composerAlways = runConfig.composerAlways;

  return {
    dimension: (process.env.EVAL_DIMENSION ?? 'all') as Dimension | 'all',
    model: process.env.EVAL_MODEL || DEFAULT_MODEL_ID,
    n: Number(process.env.EVAL_N ?? 5),
    costCapUsd: Number(process.env.EVAL_COST_CAP_USD ?? 5),
    runTimeoutMs: Number(process.env.EVAL_RUN_TIMEOUT_MS ?? 300_000),
    caseFilter: process.env.EVAL_CASES ? new RegExp(process.env.EVAL_CASES) : undefined,
    cell: Object.keys(cell).length ? cell : undefined,
    runConfig,
  };
}

function buildScorecard(
  opts: Options,
  meter: CostMeter,
  stoppedOnBudget: boolean,
  cases: CaseScore[],
  timestamp: string,
): Scorecard {
  return {
    model: opts.model,
    ...(opts.cell ? { config: opts.cell } : {}),
    timestamp,
    n: opts.n,
    costUsd: Number(meter.spentUsd.toFixed(4)),
    stoppedOnBudget,
    dimensions: summarizeDimensions(cases),
    cases,
  };
}

function withWatchdog<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Deliberately REF'D: when a durable run parks, this timer may be the only
    // live handle left — unref'd, the process drains and exits cleanly mid-loop
    // and vitest reports a PASS with a truncated scorecard (2026-07-04, twice).
    // The ref'd timer keeps the process alive until the watchdog can fire.
    const timer = setTimeout(() => reject(new RunTimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const SCORECARD_DIR = join(process.cwd(), 'evals', 'scorecards');
const BASELINE_PATH = join(process.cwd(), 'evals', 'baseline.json');

function writeScorecard(scorecard: Scorecard, quiet = false): string {
  mkdirSync(SCORECARD_DIR, { recursive: true });
  const stamp = scorecard.timestamp.replace(/[:.]/g, '-');
  const file = join(SCORECARD_DIR, `${stamp}__${cellSlug(scorecard.model, scorecard.config)}.json`);
  writeFileSync(file, JSON.stringify(scorecard, null, 2));
  if (!quiet) console.log(`\nScorecard → ${file}`);
  return file;
}

function readBaseline(): Scorecard | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Scorecard;
}

function reportDiff(current: Scorecard): void {
  const baseline = readBaseline();
  if (!baseline) {
    console.log('\nNo baseline yet — commit this scorecard to evals/baseline.json to set one.');
    return;
  }
  const regressions = diffScorecards(baseline, current);
  if (regressions.length === 0) {
    console.log('\nNo regressions vs baseline.');
    return;
  }
  console.log('\n⚠️  Regressions vs baseline:');
  for (const r of regressions) {
    console.log(
      `  ${r.scope}: ${(r.baseline * 100).toFixed(0)}% → ${(r.current * 100).toFixed(0)}% (${(r.delta * 100).toFixed(0)} pts)`,
    );
  }
}

describe('eval scorecard', () => {
  // Skip (don't fail) when there's no API key — keeps it inert + free in CI.
  it.skipIf(!process.env.ANTHROPIC_API_KEY)('runs the dataset and has no regressions', async () => {
    const opts = parseOptions();
    const cases = loadCases(opts.dimension).filter(
      (c) => !opts.caseFilter || opts.caseFilter.test(c.name),
    );
    console.log(
      `Running ${cases.length} case(s) × N=${opts.n} on ${opts.model} (cap $${opts.costCapUsd})`,
    );

    const meter = new CostMeter(opts.costCapUsd);
    const caseScores: CaseScore[] = [];
    let stoppedOnBudget = false;
    // Fixed at start so every incremental checkpoint rewrites the SAME file.
    const startedAt = new Date().toISOString();

    outer: for (const c of cases) {
      let passes = 0;
      const graderPasses: Record<string, number> = {};
      let runs = 0;
      const caseStart = Date.now();

      for (let i = 0; i < opts.n; i++) {
        try {
          meter.assertWithinBudget();
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            console.warn(`\n${err.message}`);
            stoppedOnBudget = true;
            break outer;
          }
          throw err;
        }

        let trajectory;
        try {
          trajectory = await withWatchdog(
            runEvalCase(c, opts.model, opts.runConfig),
            c.timeoutMs ?? opts.runTimeoutMs,
          );
        } catch (err) {
          if (!(err instanceof RunTimeoutError)) throw err;
          // A hung run: count it as a FAILED run and continue. NOTE the abandoned
          // run's runtime global gets overwritten by the next case — if the zombie
          // ever wakes, its steps see the new case's runtime, so treat any weird
          // subsequent result with suspicion (the warning below marks the spot).
          runs += 1;
          console.warn(`  ⏱ ${c.name} run ${i + 1}: ${String(err)} — counted as failed`);
          continue;
        }
        meter.add(estimateCostUsd(opts.model, trajectory.usage));
        runs += 1;

        const grades: GradeResult[] = [];
        for (const grader of c.graders) grades.push(await grader(trajectory, c));
        for (const grd of grades)
          if (grd.pass) graderPasses[grd.name] = (graderPasses[grd.name] ?? 0) + 1;
        if (casePassed(grades)) passes += 1;
      }

      const threshold = c.threshold ?? DEFAULT_THRESHOLD;
      const passRate = runs === 0 ? 0 : passes / runs;
      const pass = runs > 0 && passRate >= threshold;
      caseScores.push({
        name: c.name,
        dimension: c.dimension,
        history: historyTier(c),
        runs,
        passes,
        passRate,
        threshold,
        pass,
        graderPasses,
      });
      console.log(
        `  ${pass ? '✓' : '✗'} ${c.name}: ${passes}/${runs} (${(passRate * 100).toFixed(0)}% ≥ ${(threshold * 100).toFixed(0)}%) [${((Date.now() - caseStart) / 1000).toFixed(0)}s]`,
      );
      // Incremental checkpoint after EVERY case: a vitest-level timeout mid-run
      // (real-batches alone can take 45+ min at N=5) must not lose the completed
      // cases' data. Same filename each time — the final write is the full card.
      writeScorecard(buildScorecard(opts, meter, stoppedOnBudget, caseScores, startedAt), true);
    }

    const scorecard = buildScorecard(opts, meter, stoppedOnBudget, caseScores, startedAt);
    reportDiff(scorecard);
    console.log(`\nCost: $${scorecard.costUsd.toFixed(4)}`);

    // Only the DEFAULT cell (production model, no forced knobs) gates on the committed
    // baseline — a grid cell measured under different config would red-fail apples-to-oranges.
    const isDefaultCell = !opts.cell && opts.model === DEFAULT_MODEL_ID;
    const regressions = diffScorecards(readBaseline(), scorecard);
    if (!isDefaultCell) {
      if (regressions.length) {
        console.log(
          `\n(non-default cell — baseline diff informational only: ${regressions.map((r) => r.scope).join(', ')})`,
        );
      }
      return;
    }
    expect(regressions, regressions.map((r) => r.scope).join(', ')).toHaveLength(0);
  });
});
