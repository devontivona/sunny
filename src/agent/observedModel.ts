import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';

/**
 * Model-level generation tracing for DURABLE runs (observability; the WorkflowAgent telemetry
 * gap, vercel/ai #12164).
 *
 * WHY this exists: AI SDK v7 telemetry is integration-based (`registerTelemetry` +
 * `@ai-sdk/otel`), and `WorkflowAgent` dispatches EVERY telemetry event from the agent loop —
 * which runs in the WDK `node:vm` sandbox. The sandbox has an isolated `globalThis`, so the
 * host-registered integrations are invisible there (and even if they weren't, the workflow body
 * REPLAYS from the top on every resume, which would re-emit spans for already-journaled steps —
 * the duplicate-trace failure mode of earlier attempts). The actual model call, however, happens
 * exactly once per step on the HOST: `@ai-sdk/workflow`'s journaled `doStreamStep` receives the
 * model INSTANCE via the WDK class-serialization protocol and calls `doStream` there. Upstream
 * tracks first-class WorkflowAgent telemetry as an open follow-up on the v7.1 milestone; until
 * it ships, the model instance is the one seam the libraries hand us on the host side.
 *
 * So: this wrapper rides the SAME serialization protocol the real providers implement
 * (`WORKFLOW_SERIALIZE`/`WORKFLOW_DESERIALIZE` from `@workflow/serde`; the inner model nests via
 * its own protocol — WDK's devalue reducers recurse). Its `doStream` runs on the host inside
 * WDK's `STEP doStreamStep` span (the `@opentelemetry/api` global registry lives on
 * `globalThis[Symbol.for(...)]`, shared across the server and step bundles), so each generation
 * span is emitted EXACTLY ONCE per real model call and nests inside the run's trace:
 * `workflow.start <profile>` → `STEP doStreamStep` → `chat <modelId>`. Replays reuse the
 * journaled step result and never re-enter `doStream`; a WDK retry re-executes the step and
 * honestly emits a fresh span.
 *
 * Attribute dialect: the span carries gen_ai semconv core (operation/provider/model/usage/
 * finish reasons) plus `langfuse.observation.type = 'generation'` so Langfuse ingests it as a
 * generation, and the v6-style payload attributes (`ai.prompt.messages`, `ai.response.text`,
 * `ai.response.toolCalls`) that `TracePromotingSpanProcessor` and Langfuse's server-side
 * mapping already understand. `ai.settings.context.langfuseSessionId` + `gen_ai.agent.name`
 * feed the trace-level name/session promotion. Everything passes through the
 * `RedactingSpanProcessor` before export, same as every other span.
 *
 * Node-free at module scope (`@opentelemetry/api` is pure JS), so it is safe to import from
 * workflow code: the wrapper is CONSTRUCTED in the workflow body (`buildTurnModel`) and
 * serialized across the step boundary; `doStream` only ever executes on the host. When
 * telemetry is off (no Langfuse keys → no SDK → noop tracer provider), spans are
 * non-recording and the wrapper skips the payload work.
 */

/** Per-run trace identity, journaled with the model across the step boundary. */
export interface ObserveMeta {
  /** Trace name in Langfuse (`agent-turn`, `background-job`, `scheduled-job`, `subagent-run`). */
  functionId: string;
  /** Langfuse session grouping — the thread the run belongs to. */
  sessionId: string;
}

const MAX_ATTR_JSON = 100_000;

/** JSON.stringify capped for span attributes (a pathological prompt must not balloon a span). */
function attrJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > MAX_ATTR_JSON ? `${s.slice(0, MAX_ATTR_JSON)}…` : s;
  } catch {
    return '[unserializable]';
  }
}

/** `anthropic.messages` → `anthropic` (gen_ai.provider.name wants the bare provider). */
function bareProvider(provider: string): string {
  const dot = provider.indexOf('.');
  return dot === -1 ? provider : provider.slice(0, dot);
}

export class ObservedLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;

  constructor(
    public readonly inner: LanguageModelV4,
    public readonly meta: ObserveMeta,
  ) {}

  get provider(): string {
    return this.inner.provider;
  }
  get modelId(): string {
    return this.inner.modelId;
  }
  get supportedUrls(): LanguageModelV4['supportedUrls'] {
    return this.inner.supportedUrls;
  }

  doGenerate(options: LanguageModelV4CallOptions): ReturnType<LanguageModelV4['doGenerate']> {
    // Pass through untraced: durable runs stream (doStream); host-side generateText callers
    // (translator/backstop/judge) use the vanilla v7 integration, which must not double-count.
    return this.inner.doGenerate(options);
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const tracer = trace.getTracer('sunny.observed-model');
    const span = tracer.startSpan(`chat ${this.modelId}`, { kind: SpanKind.CLIENT });
    const recording = span.isRecording();
    if (recording) {
      span.setAttributes({
        'langfuse.observation.type': 'generation',
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': bareProvider(this.provider),
        'gen_ai.request.model': this.modelId,
        'gen_ai.agent.name': this.meta.functionId,
        'ai.settings.context.langfuseSessionId': this.meta.sessionId,
        // `ai.prompt.messages` feeds the TracePromotingSpanProcessor (trace input); the
        // `langfuse.observation.*` twin is the native key this Langfuse version maps to the
        // OBSERVATION's input/output (verified 2026-07-06: the v6-style attr alone leaves the
        // generation's I/O empty in the UI).
        'ai.prompt.messages': attrJson(options.prompt),
        'langfuse.observation.input': attrJson(options.prompt),
      });
    }

    let result: LanguageModelV4StreamResult;
    try {
      result = await this.inner.doStream(options);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.end();
      throw err;
    }
    if (!recording) {
      span.end();
      return result;
    }
    return { ...result, stream: observeStream(result.stream, span) };
  }

  static [WORKFLOW_SERIALIZE](model: ObservedLanguageModel): {
    inner: LanguageModelV4;
    meta: ObserveMeta;
  } {
    // The inner provider instance serializes via ITS protocol (devalue reducers recurse).
    return { inner: model.inner, meta: model.meta };
  }
  static [WORKFLOW_DESERIALIZE](data: {
    inner: LanguageModelV4;
    meta: ObserveMeta;
  }): ObservedLanguageModel {
    return new ObservedLanguageModel(data.inner, data.meta);
  }
}

/**
 * Tee the provider stream to record the generation's output on `span`, ending it when the
 * stream settles (close, error, or consumer cancel — each path ends the span exactly once, so
 * an aborted call still exports an honest, ERROR-status span instead of leaking an open one).
 */
function observeStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  span: Span,
): ReadableStream<LanguageModelV4StreamPart> {
  let text = '';
  const toolCalls: { toolCallId: string; toolName: string; input: string }[] = [];
  let usage: LanguageModelV4Usage | undefined;
  let finishReason: LanguageModelV4FinishReason | undefined;
  let ended = false;

  const end = (error?: unknown) => {
    if (ended) return;
    ended = true;
    if (text) span.setAttribute('ai.response.text', text);
    if (toolCalls.length > 0) span.setAttribute('ai.response.toolCalls', attrJson(toolCalls));
    if (text || toolCalls.length > 0) {
      span.setAttribute(
        'langfuse.observation.output',
        toolCalls.length > 0 ? attrJson({ text: text || undefined, toolCalls }) : text,
      );
    }
    if (finishReason) span.setAttribute('gen_ai.response.finish_reasons', [finishReason.unified]);
    if (usage) {
      const set = (key: string, v: number | undefined) => {
        if (typeof v === 'number') span.setAttribute(key, v);
      };
      set('gen_ai.usage.input_tokens', usage.inputTokens.total);
      set('gen_ai.usage.output_tokens', usage.outputTokens.total);
      set('gen_ai.usage.cache_read.input_tokens', usage.inputTokens.cacheRead);
      set('gen_ai.usage.cache_creation.input_tokens', usage.inputTokens.cacheWrite);
    }
    if (error !== undefined) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  };

  const observe = (part: LanguageModelV4StreamPart) => {
    switch (part.type) {
      case 'text-delta':
        text += part.delta;
        break;
      case 'tool-call':
        toolCalls.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: typeof part.input === 'string' ? part.input : attrJson(part.input),
        });
        break;
      case 'finish':
        usage = part.usage;
        finishReason = part.finishReason;
        break;
      case 'error':
        end(part.error);
        break;
    }
  };

  const reader = stream.getReader();
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      try {
        const read = await reader.read();
        if (read.done) {
          end();
          controller.close();
          return;
        }
        observe(read.value);
        controller.enqueue(read.value);
      } catch (err) {
        end(err);
        controller.error(err);
      }
    },
    cancel(reason) {
      end(reason ?? 'stream cancelled');
      return reader.cancel(reason);
    },
  });
}
