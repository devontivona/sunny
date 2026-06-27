import { defineConfig } from 'vitest/config';
import { workflow } from '@workflow/vitest';

/**
 * Workflow integration tests (durable-main-loop) — the WDK best-practice path. The
 * `workflow()` plugin compiles the `'use workflow'`/`'use step'` directives, builds the
 * workflow/step bundles, and runs each test against a FRESH in-process Local World (no
 * Postgres, no server) — so we can `start(runConversation, …)` and assert the real turn,
 * its mid-turn folding, and exactly-once delivery on replay.
 *
 * Kept in its own config + file convention (`*.workflow.test.ts`) so it never mixes with the
 * unit/integration Vitest projects (those have no workflow plugin). Run: `npm run test:workflow`.
 */
export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ['tests/workflow/**/*.workflow.test.ts'],
    // Loads ANTHROPIC_API_KEY etc. so module imports that read env don't throw; the turn
    // model itself is mocked via the test seam, so no live model is called.
    setupFiles: ['./tests/setup/env.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One Local World + one PGlite app store per file; keep files from racing on them.
    fileParallelism: false,
  },
});
