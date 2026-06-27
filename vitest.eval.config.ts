import { defineConfig } from 'vitest/config';
import { workflow } from '@workflow/vitest';

/**
 * Behavioral evals (agent-evals spec) — run under the `@workflow/vitest` plugin so the eval
 * harness can drive the REAL durable turn (`runConversation`) in an in-process Local World. This
 * replaces the old `tsx evals/run.ts` entrypoint: `tsx` can't run a `'use workflow'` function, so
 * the scorecard runner (`evals/run.eval.test.ts`) and the vitest-evals suite (`evals/suite.eval.test.ts`)
 * both execute here. PAID + non-deterministic (real model) → OFF the merge gate; on demand only.
 *
 * Options come from env (EVAL_DIMENSION / EVAL_MODEL / EVAL_N / EVAL_COST_CAP_USD) — vitest owns
 * the CLI args, so the old `--flag`s are env vars now (`npm run eval`).
 */
export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ['evals/**/*.eval.test.ts'],
    setupFiles: ['./tests/setup/env.ts'], // ANTHROPIC_API_KEY etc.
    testTimeout: 600_000, // a full N-run scorecard against a real model is long; the cost cap bounds it
    hookTimeout: 120_000,
    fileParallelism: false, // one Local World + one PGlite store at a time
  },
});
