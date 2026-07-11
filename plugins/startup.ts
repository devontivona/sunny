/**
 * On server init: start the WDK Postgres world (subscribe to the graphile-worker
 * queue so durable steps/jobs run), then start Sunny's runtime (DB, memory,
 * gateway). Both are memoized/idempotent. A Nitro plugin is just a default-
 * exported function (`defineNitroPlugin` is an identity helper), so we skip it.
 */
export default async (): Promise<void> => {
  // Start OpenTelemetry → Langfuse BEFORE the runtime/AI-SDK is imported, so the
  // global tracer is registered before any LLM/tool/step call runs (observability
  // D-OB1; task 3). No-op when Langfuse keys are absent.
  const { startTelemetry } = await import('../src/observability/instrumentation.js');
  startTelemetry();

  // Provision the WDK world tables idempotently BEFORE the world subscribes
  // (first-run-setup: a fresh clone + env + start must be fully provisioned — no
  // README-only manual step). Runs the package's own setup bin (`npx
  // workflow-postgres-setup`, a drizzle migrator with its own migrations table —
  // an already-provisioned database is a fast no-op) as a CHILD PROCESS: importing
  // its module here gets bundled by Nitro, which breaks its CJS `__dirname` and
  // strands its migrations folder. `node_modules` is on disk in prod (cwd = repo
  // root, the drizzle/ contract), so the bin path is stable.
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { join } = await import('node:path');
    const setupBin = join(process.cwd(), 'node_modules', '@workflow', 'world-postgres', 'bin', 'setup.js');
    await promisify(execFile)(process.execPath, [setupBin], { timeout: 60_000 });
    console.log('[startup] WDK world tables verified/provisioned');
  } catch (err) {
    console.error(
      '[startup] WDK world-table setup failed — durable workflows may not run until ' +
        `\`npm run db:setup-world\` succeeds: ${String(err)}`,
    );
  }

  const { getWorld } = await import('workflow/runtime');
  await getWorld().start?.();

  const { getRuntime } = await import('../src/runtime.js');
  await getRuntime();
};
