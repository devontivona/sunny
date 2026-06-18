import type { Dimension } from './types.js';

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
  runs: number;
  passes: number;
  passRate: number;
  threshold: number;
  pass: boolean;
  /** Per-grader pass counts across the N runs, for debugging. */
  graderPasses: Record<string, number>;
}

export interface Scorecard {
  model: string;
  timestamp: string;
  n: number;
  costUsd: number;
  /** True if the run stopped early on the cost cap. */
  stoppedOnBudget?: boolean;
  dimensions: Record<string, { passRate: number; pass: boolean }>;
  cases: CaseScore[];
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
