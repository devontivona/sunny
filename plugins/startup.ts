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

  const { getWorld } = await import('workflow/runtime');
  await getWorld().start?.();

  const { getRuntime } = await import('../src/runtime.js');
  await getRuntime();
};
