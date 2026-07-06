import type { Span, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { AttributeValue } from '@opentelemetry/api';

/**
 * Promote per-span AI-SDK telemetry to Langfuse TRACE-level fields (durable-main-loop 5.6).
 *
 * Why this exists: `@workflow/ai`'s `DurableAgent` runs each model call as a durable WDK step,
 * so the AI-SDK generation/tool spans are CHILDREN of an unnamed WDK run/step wrapper — the
 * true OTel root. Langfuse derives the trace name/session from the OTel root, so for durable
 * runs (conversational turns AND Tier-2 jobs) the trace shows up unnamed + un-sessioned even
 * though every child span carries the data. The in-process `ToolLoopAgent` looked fine only
 * because its `ai.streamText` span WAS the OTel root.
 *
 * Fix: the AI-SDK records the function id + per-call metadata and the prompt/response
 * (`ai.prompt.messages`, `ai.response.text`/`toolCalls`) on its spans; Langfuse promotes
 * `langfuse.trace.{name,session.id,user.id,input,output}` to the trace from ANY span in it (per
 * the Langfuse OpenTelemetry mapping). So we copy them across on every AI-SDK span.
 *
 * Two span dialects feed this processor:
 * - HOST-side vanilla calls (translator, backstop, judge) via the `@ai-sdk/otel` integration:
 *   function id in `gen_ai.agent.name`, session in `ai.settings.context.*` (fed through
 *   `telemetry.includeRuntimeContext`), payloads in semconv `gen_ai.input/output.messages`.
 * - DURABLE runs via `ObservedLanguageModel` (the WorkflowAgent telemetry gap, see
 *   observedModel.ts): same id/session attributes, payloads in the v6-style
 *   `ai.prompt.messages`/`ai.response.text`/`ai.response.toolCalls`.
 * We read both, v6 names first (exact fit) with semconv fallback. So we copy:
 * - name/session/user are constant across a turn's spans → set once, idempotent.
 * - input  = the user's message (last user turn in the prompt) — same on every step → consistent.
 * - output = the delivered reply. Text-as-reply (PR #31): the FINAL step's model text IS the
 *   reply, so a span claims the output only when it finished `stop` (tool-call steps carry
 *   narration, not the reply), with the legacy `send_message` extraction as fallback.
 * No-op on any span without our metadata (WDK infra, etc.). Auxiliary passes that run WITHIN a
 * turn (`turn-backstop` — né `delivery-recovery` — and `progress-translator`) must NOT claim the
 * trace name/input; the backstop still claims output (it composes the delivered reply on
 * abnormal turns), the translator claims nothing.
 *
 * Registered BEFORE the `LangfuseSpanProcessor` so the promoted attributes are present when it
 * exports (mirrors `RedactingSpanProcessor`: `onEnding` while writable, `onEnd` as a fallback).
 */
// Source attribute candidates (see header). `pick` returns the first present string value.
const SESSION_META = [
  'ai.settings.context.langfuseSessionId',
  'ai.telemetry.metadata.langfuseSessionId',
];
const USER_META = ['ai.settings.context.langfuseUserId', 'ai.telemetry.metadata.langfuseUserId'];
const FUNCTION_ID = ['gen_ai.agent.name', 'ai.telemetry.functionId'];
const PROMPT_MESSAGES = ['ai.prompt.messages', 'gen_ai.input.messages'];
const RESPONSE_TEXT = ['ai.response.text'];
const RESPONSE_TOOLCALLS = ['ai.response.toolCalls'];
const OUTPUT_MESSAGES = ['gen_ai.output.messages'];
const FINISH_REASONS = ['gen_ai.response.finish_reasons'];
/** In-turn auxiliary passes: never name the trace or claim its input (see header). */
const AUX_BACKSTOP = ['delivery-recovery', 'turn-backstop'];
const AUX_SILENT = ['progress-translator'];

/** First present string attribute among `keys`, else undefined. */
function pick(
  attrs: Record<string, AttributeValue | undefined>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

const TRACE_NAME = 'langfuse.trace.name';
const SESSION_ID = 'langfuse.session.id';
const USER_ID = 'langfuse.user.id';
const TRACE_INPUT = 'langfuse.trace.input';
const TRACE_OUTPUT = 'langfuse.trace.output';

const MAX_IO = 8000;

/** Last user message in a prompt-messages JSON string (`ai.prompt.messages` carries `content`;
 *  semconv `gen_ai.input.messages` carries `parts`) — the turn's input. */
function lastUserText(raw: AttributeValue | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const msgs = JSON.parse(raw);
    if (!Array.isArray(msgs)) return undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'user') return textOf(msgs[i].content ?? msgs[i].parts);
    }
  } catch {
    /* malformed attribute — skip */
  }
  return undefined;
}

/** Assistant text of a semconv `gen_ai.output.messages` JSON string. */
function semconvOutputText(raw: AttributeValue | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const msgs = JSON.parse(raw);
    if (!Array.isArray(msgs)) return undefined;
    const t = msgs
      .map((m) => textOf(m?.parts))
      .filter(Boolean)
      .join('\n')
      .trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** Whether the span's model call finished `stop` (the reply-bearing final step; tool-call
 *  steps finish `tool-calls` and carry narration, not the reply). */
function finishedStop(raw: AttributeValue | undefined): boolean {
  if (typeof raw === 'string') return raw === 'stop';
  return Array.isArray(raw) && (raw as unknown[]).includes('stop');
}

/** A model-message `content`/`parts` (string or part array) flattened to its text. Handles the
 *  v6/provider part shape (`{type:'text', text}`) AND semconv (`{type:'text', content}`). */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (Array.isArray(content)) {
    const t = content
      .filter((p) => p?.type === 'text')
      .map((p) =>
        typeof p.text === 'string' ? p.text : typeof p.content === 'string' ? p.content : '',
      )
      .join('\n')
      .trim();
    return t || undefined;
  }
  return undefined;
}

/**
 * Sunny's DELIVERED reply on a turn = the `send_message` tool-call text(s). A turn's plain model
 * text is SCRATCH (D-MG8), never delivered, so it must NOT be used as the trace output. (The
 * delivery-recovery checkpoint is the exception — it generates the reply AS model text — handled
 * by the caller.)
 */
function sendMessageText(toolCalls: AttributeValue | undefined): string | undefined {
  if (typeof toolCalls !== 'string') return undefined;
  try {
    const calls = JSON.parse(toolCalls);
    if (!Array.isArray(calls)) return undefined;
    const texts = calls
      .filter((c) => (c?.toolName ?? c?.name) === 'send_message')
      .map((c) => {
        const a = c?.args ?? c?.input;
        const obj = typeof a === 'string' ? JSON.parse(a) : a;
        return typeof obj?.text === 'string' ? obj.text : undefined;
      })
      .filter((t): t is string => !!t && t.trim().length > 0);
    return texts.length ? texts.join('\n') : undefined;
  } catch {
    return undefined;
  }
}

/** Non-empty trimmed model text, or undefined. */
function modelText(text: AttributeValue | undefined): string | undefined {
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

export class TracePromotingSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
    this.promote(span.attributes as Record<string, AttributeValue | undefined>, (k, v) =>
      span.setAttribute(k, v),
    );
  }

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, AttributeValue | undefined>;
    this.promote(attrs, (k, v) => {
      attrs[k] = v;
    });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /** Copy AI-SDK telemetry into Langfuse trace-level attributes when present. */
  private promote(
    attrs: Record<string, AttributeValue | undefined>,
    set: (key: string, value: string) => void,
  ): void {
    const session = pick(attrs, SESSION_META);
    if (typeof session !== 'string') return; // not one of our AI-SDK agent/job spans
    if (typeof attrs[SESSION_ID] !== 'string') set(SESSION_ID, session);

    const user = pick(attrs, USER_META);
    if (typeof user === 'string' && typeof attrs[USER_ID] !== 'string') set(USER_ID, user);

    const functionId = pick(attrs, FUNCTION_ID);
    const isBackstop =
      typeof functionId === 'string' && AUX_BACKSTOP.some((p) => functionId.startsWith(p));
    const isSilentAux =
      typeof functionId === 'string' && AUX_SILENT.some((p) => functionId.startsWith(p));

    // Name + input come from the primary turn/job spans only — an in-turn auxiliary pass
    // (backstop, translator) would otherwise hijack them from `agent-turn`/`*-job`.
    if (!isBackstop && !isSilentAux) {
      if (typeof functionId === 'string' && typeof attrs[TRACE_NAME] !== 'string') {
        set(TRACE_NAME, functionId);
      }
      const input = lastUserText(pick(attrs, PROMPT_MESSAGES));
      if (input && typeof attrs[TRACE_INPUT] !== 'string') set(TRACE_INPUT, input.slice(0, MAX_IO));
    }

    // Output = the DELIVERED reply (text-as-reply, PR #31): the final `stop` step's model text
    // on a primary span (tool-call steps carry narration, skipped), the composed text on a
    // backstop span (it generates the reply on abnormal turns), nothing from the translator.
    // Legacy `send_message` extraction kept as the non-final fallback. Last non-empty wins.
    const text =
      modelText(pick(attrs, RESPONSE_TEXT)) ?? semconvOutputText(pick(attrs, OUTPUT_MESSAGES));
    let output: string | undefined;
    if (isBackstop) {
      output = text;
    } else if (!isSilentAux) {
      output = finishedStop(attrs[FINISH_REASONS[0]!])
        ? text
        : sendMessageText(pick(attrs, RESPONSE_TOOLCALLS));
    }
    if (output) set(TRACE_OUTPUT, output.slice(0, MAX_IO));
  }
}
