/**
 * OpenTelemetry tracing → self-hosted Langfuse (observability D-OB1/D-OB7;
 * change `observability` task 3).
 *
 * Sunny emits OpenTelemetry spans for LLM/tool/step activity (via the AI SDK's
 * `experimental_telemetry`) and durable jobs (WDK), exported over OTLP to a
 * self-hosted Langfuse instance — no egress. We use Langfuse's own
 * `LangfuseSpanProcessor` on a `NodeSDK` (the framework integration the Langfuse
 * docs recommend for the Vercel AI SDK), which speaks OTLP under the hood.
 *
 * Redaction-at-source (D-OB5): the `LangfuseSpanProcessor`'s built-in `mask`
 * only covers Langfuse-native attributes (`langfuse.observation.*`). The Vercel
 * AI SDK records prompts/responses in RAW OTel attributes (`ai.prompt`,
 * `ai.response.*`, tool args) that Langfuse maps server-side — those would slip
 * past `mask`. So we run our own `RedactingSpanProcessor` that scrubs EVERY span
 * attribute through the task-2 redactor before export. It is registered first
 * and also rewrites in `onEnding` (while the span is still writable), so the
 * Langfuse exporter only ever sees redacted attributes — secrets never reach
 * Langfuse/Clickhouse.
 *
 * `startTelemetry()` is called before the runtime/AI-SDK is used (see
 * `plugins/startup.ts`). It is a no-op unless Langfuse keys are present, so dev
 * and tests run with tracing off by default.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import type { SpanProcessor, ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import type { AttributeValue } from '@opentelemetry/api';
import { defaultRedactor, type Redactor } from './redact.js';
import { TracePromotingSpanProcessor } from './tracePromotion.js';
import { telemetryEnabled } from './enabled.js';
import { logger } from '../logger.js';

// Re-export so existing importers (e.g. the agent loop) keep their path; the env-only
// check lives in `enabled.js` so workflow/sandbox code can import it without the
// heavy OTel/Langfuse deps above.
export { telemetryEnabled };

const log = logger('observability:otel');

let sdk: NodeSDK | undefined;
let langfuseProcessor: LangfuseSpanProcessor | undefined;

/**
 * Scrubs secrets from every span attribute before export — the D-OB5 gate on
 * the Langfuse sink. Redacts in `onEnding` (span still writable) and, as a
 * fallback, in `onEnd` (in place; this processor is registered before the
 * Langfuse exporter so its `onEnd` runs first). Redacting an already-redacted
 * string is a no-op, so running in both hooks is safe.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly redactor: Redactor) {}

  onStart(): void {}

  onEnding(span: Span): void {
    for (const [key, value] of Object.entries(span.attributes)) {
      const redacted = this.redactAttribute(value);
      if (redacted !== undefined) span.setAttribute(key, redacted);
    }
  }

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, AttributeValue | undefined>;
    for (const [key, value] of Object.entries(attrs)) {
      const redacted = this.redactAttribute(value);
      if (redacted !== undefined) attrs[key] = redacted;
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /** Returns the redacted value, or `undefined` when nothing changed. */
  private redactAttribute(value: AttributeValue | undefined): AttributeValue | undefined {
    if (typeof value === 'string') {
      const redacted = this.redactor.redactString(value);
      return redacted === value ? undefined : redacted;
    }
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        if (typeof item !== 'string') return item;
        const redacted = this.redactor.redactString(item);
        if (redacted !== item) changed = true;
        return redacted;
      });
      return changed ? (out as AttributeValue) : undefined;
    }
    return undefined;
  }
}

/** Start the OTel SDK + Langfuse exporter. Idempotent; no-op when disabled. */
export function startTelemetry(): void {
  if (sdk) return;
  if (!telemetryEnabled()) {
    log.info('tracing disabled (no Langfuse keys, or SUNNY_OTEL_DISABLED=1)');
    return;
  }
  langfuseProcessor = new LangfuseSpanProcessor();
  sdk = new NodeSDK({
    // Order matters: redaction runs first (the exporter only sees scrubbed attributes), then
    // trace-promotion copies durable runs' AI-SDK telemetry onto Langfuse trace-level
    // attributes (so durable turns/jobs get named + session-grouped traces, not just child
    // observations), then the Langfuse exporter sees the finished attributes.
    spanProcessors: [
      new RedactingSpanProcessor(defaultRedactor()),
      new TracePromotingSpanProcessor(),
      langfuseProcessor,
    ],
  });
  sdk.start();
  log.info('tracing enabled → Langfuse', {
    baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
  });
}

/** Flush buffered spans to Langfuse (for scripts/evals/shutdown). */
export async function flushTelemetry(): Promise<void> {
  await langfuseProcessor?.forceFlush();
}

/** Shut the SDK down and flush. Idempotent. */
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
  langfuseProcessor = undefined;
}
