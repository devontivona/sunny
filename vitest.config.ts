import { defineConfig } from 'vitest/config';

/**
 * Single runner, three lanes separated by Vitest projects (design D1):
 *
 * - **unit** (`*.unit.test.ts`) — pure logic, no I/O, no DB, no model. The fast,
 *   always-green default.
 * - **integration** (`*.integration.test.ts`) — real modules against an
 *   in-process PGlite Postgres (D4). A fresh in-memory DB is created per test
 *   file by the `createTestDb()` fixture (no global setup, no Docker).
 * - **evals** (`evals/**`) — the paid behavioral layer. EXCLUDED from the default
 *   run and the CI gate (D9): it drives a real model and costs money, so it is
 *   only ever selected explicitly (`--project evals`, via `npm run eval`).
 *
 * `npm test` runs the unit project; `npm run test:integration` the integration
 * project; `npm run test:all` both. Nothing here runs evals.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'src/**/*.unit.test.ts',
            'tests/**/*.unit.test.ts',
            // Pure eval-engine logic (cost math, scorecard diff) — deterministic,
            // gated. The paid eval suites are `*.eval.test.ts` (evals project).
            'evals/**/*.unit.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts', 'tests/**/*.integration.test.ts'],
          // Loads ANTHROPIC_API_KEY (from .env locally / the CI secret) for the
          // real-model recovery test; no-op for the mock-only files.
          setupFiles: ['./tests/setup/env.ts'],
          // PGlite is single-connection; keep DB-backed files from racing on one
          // engine by running this lane single-file (each file gets its own DB).
          fileParallelism: false,
          // Migrations + WASM Postgres boot add a little per-file overhead.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'evals',
          environment: 'node',
          include: ['evals/**/*.eval.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
