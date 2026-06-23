/**
 * Whether OpenTelemetry → Langfuse tracing is on: Langfuse credentials present and
 * not explicitly disabled. Used to gate per-call `experimental_telemetry.isEnabled`.
 *
 * Env-only ON PURPOSE — no `@opentelemetry/*` / `@langfuse/*` imports — so it is safe
 * to import from workflow/orchestrator code that loads in the WDK sandbox (where those
 * Node modules are unavailable). The heavy SDK setup lives in `instrumentation.ts`,
 * which re-exports this.
 */
export function telemetryEnabled(): boolean {
  if (process.env.SUNNY_OTEL_DISABLED === '1') return false;
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}
