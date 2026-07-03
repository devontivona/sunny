import type { Dimension, GradeResult, HistoryTier } from './types.js';

/**
 * Pass-rate scoring (task 7.5) + file-based scorecards with regression diff
 * (task 7.6 / design D8/D10). Each case runs N times; the score is the pass rate
 * vs a per-case/dimension threshold (a single failing sample is signal, not a red
 * build). The committed `evals/baseline.json` is the diff target; re-baselining is
 * an explicit, reviewed commit.
 */

/** Lenient initial default (D8) — tighten as behavior stabilizes. */
export const DEFAULT_THRESHOLD = 0.6;

export interface CaseScore {
  name: string;
  dimension: Dimension;
  /** History tier the graded turn ran against (live / seeded-clean / seeded-poisoned).
   *  Poisoned-history cases measure robustness under bad in-context precedent — a
   *  different metric from clean-history elicitation; report them separately. */
  history?: HistoryTier;
  runs: number;
  passes: number;
  passRate: number;
  threshold: number;
  pass: boolean;
  /** Per-grader pass counts across the N runs, for debugging. */
  graderPasses: Record<string, number>;
}

/** The non-default run configuration a scorecard was measured under (grid cell id). */
export interface ScorecardConfig {
  thinking?: string;
  effort?: string;
  promptVariant?: string;
  fewshot?: boolean;
  composerAlways?: boolean;
}

export interface Scorecard {
  model: string;
  /** Present only when the run forced non-default knobs (a grid cell). A scorecard
   *  without `config` is the default cell — the only one baseline.json diffs against. */
  config?: ScorecardConfig;
  timestamp: string;
  n: number;
  costUsd: number;
  /** True if the run stopped early on the cost cap. */
  stoppedOnBudget?: boolean;
  dimensions: Record<string, { passRate: number; pass: boolean }>;
  cases: CaseScore[];
}

/** A case run passes when every NON-advisory grader passes — advisory verdicts
 *  (quality metrics like scratch-is-working-notes) are tracked but never gate. */
export function casePassed(grades: GradeResult[]): boolean {
  return grades.filter((g) => !g.advisory).every((g) => g.pass);
}

/** Filename slug for a grid cell, e.g. `claude-sonnet-5__t-off__v-gateway__fs1`. */
export function cellSlug(model: string, config?: ScorecardConfig): string {
  const parts = [model];
  if (config?.thinking) parts.push(`t-${config.thinking}`);
  if (config?.effort) parts.push(`e-${config.effort}`);
  if (config?.promptVariant) parts.push(`v-${config.promptVariant}`);
  if (config?.fewshot !== undefined) parts.push(`fs${config.fewshot ? 1 : 0}`);
  if (config?.composerAlways) parts.push('composer');
  return parts.join('__');
}

export function summarizeDimensions(cases: CaseScore[]): Scorecard['dimensions'] {
  const byDim = new Map<string, CaseScore[]>();
  for (const c of cases) {
    const list = byDim.get(c.dimension) ?? [];
    list.push(c);
    byDim.set(c.dimension, list);
  }
  const out: Scorecard['dimensions'] = {};
  for (const [dim, list] of byDim) {
    const passRate = list.reduce((s, c) => s + c.passRate, 0) / list.length;
    out[dim] = { passRate, pass: list.every((c) => c.pass) };
  }
  return out;
}

export interface Regression {
  scope: string;
  baseline: number;
  current: number;
  delta: number;
}

/** Cases/dimensions whose pass rate dropped vs the baseline (beyond `epsilon`). */
export function diffScorecards(
  baseline: Scorecard | null,
  current: Scorecard,
  epsilon = 0.001,
): Regression[] {
  if (!baseline) return [];
  const regressions: Regression[] = [];

  for (const [dim, cur] of Object.entries(current.dimensions)) {
    const base = baseline.dimensions[dim];
    if (base && cur.passRate < base.passRate - epsilon) {
      regressions.push({
        scope: `dimension:${dim}`,
        baseline: base.passRate,
        current: cur.passRate,
        delta: cur.passRate - base.passRate,
      });
    }
  }

  const baseCases = new Map(baseline.cases.map((c) => [c.name, c]));
  for (const cur of current.cases) {
    const base = baseCases.get(cur.name);
    if (base && cur.passRate < base.passRate - epsilon) {
      regressions.push({
        scope: `case:${cur.name}`,
        baseline: base.passRate,
        current: cur.passRate,
        delta: cur.passRate - base.passRate,
      });
    }
  }
  return regressions;
}
