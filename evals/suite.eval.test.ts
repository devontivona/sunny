import { describeEval } from 'vitest-evals/legacy';
import { DEFAULT_MODEL_ID, envRunConfig, runEvalCase } from './harness.js';
import { loadCases } from './cases/index.js';
import type { Dimension, Trajectory } from './types.js';

/**
 * vitest-evals wiring (task 7.1). Exposes the dataset as native Vitest eval
 * suites via the scorer-first `describeEval` API: each case's `task` drives the
 * REAL loop through {@link runEvalCase} and its graders become scorers.
 *
 * This is the test-style entrypoint (`vitest --project evals`); `npm run eval`
 * (evals/run.ts) is the N-run/scorecard/cost-capped entrypoint. Both are OFF the
 * merge gate. `skipIf` keeps this inert (and free) whenever no API key is present
 * — e.g. in CI — so it never costs money by accident.
 */
const MODEL = process.env.EVAL_MODEL || DEFAULT_MODEL_ID;
const DIMENSION = (process.env.EVAL_DIMENSION as Dimension | 'all') || 'all';
const RUN_CONFIG = envRunConfig();

// The task captures the trajectory; scorers (which only receive output/toolCalls)
// read it back by case name so our richer Grader functions can be reused as-is.
const captured = new Map<string, Trajectory>();

for (const c of loadCases(DIMENSION)) {
  describeEval(c.name, {
    skipIf: () => !process.env.ANTHROPIC_API_KEY,
    data: async () => [
      { name: c.name, input: Array.isArray(c.input) ? c.input.join(' / ') : c.input },
    ],
    task: async () => {
      const t = await runEvalCase(c, MODEL, RUN_CONFIG);
      captured.set(c.name, t);
      return {
        result: t.finalText,
        toolCalls: t.toolCalls.map((tc) => ({
          name: tc.name,
          arguments: tc.input as Record<string, unknown>,
        })),
      };
    },
    scorers: c.graders.map((grader) => async () => {
      const t = captured.get(c.name);
      if (!t) return { score: 0, metadata: { rationale: 'no trajectory captured' } };
      const r = await grader(t, c);
      return { score: r.pass ? 1 : 0, metadata: { rationale: r.rationale } };
    }),
    threshold: c.threshold ?? 0.6,
  });
}
