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
 * Fix: the AI-SDK records `ai.telemetry.functionId`/`ai.telemetry.metadata.langfuse*` and the
 * prompt/response (`ai.prompt.messages`, `ai.response.text`/`toolCalls`) on its spans; Langfuse
 * promotes `langfuse.trace.{name,session.id,user.id,input,output}` to the trace from ANY span in
 * it (per the Langfuse OpenTelemetry mapping). So we copy them across on every AI-SDK span:
 * - name/session/user are constant across a turn's spans → set once, idempotent.
 * - input  = the user's message (last user turn in the prompt) — same on every step → consistent.
 * - output = the delivered reply (model text, or `send_message` text) — set last-write-wins so the
 *   final reply lands.
 * No-op on any span without our metadata (WDK infra, etc.). One wrinkle: the `delivery-recovery`
 * checkpoint runs WITHIN a turn (its own `functionId`), so it must NOT claim the trace name — we
 * skip naming from it, letting the `agent-turn`/`*-job` span name the trace.
 *
 * Registered BEFORE the `LangfuseSpanProcessor` so the promoted attributes are present when it
 * exports (mirrors `RedactingSpanProcessor`: `onEnding` while writable, `onEnd` as a fallback).
 */
const SESSION_META = 'ai.telemetry.metadata.langfuseSessionId';
const USER_META = 'ai.telemetry.metadata.langfuseUserId';
const FUNCTION_ID = 'ai.telemetry.functionId';
const PROMPT_MESSAGES = 'ai.prompt.messages';
const RESPONSE_TEXT = 'ai.response.text';
const RESPONSE_TOOLCALLS = 'ai.response.toolCalls';

const TRACE_NAME = 'langfuse.trace.name';
const SESSION_ID = 'langfuse.session.id';
const USER_ID = 'langfuse.user.id';
const TRACE_INPUT = 'langfuse.trace.input';
const TRACE_OUTPUT = 'langfuse.trace.output';

const MAX_IO = 8000;

/** Last user message in an `ai.prompt.messages` JSON string — the turn's input. */
function lastUserText(raw: AttributeValue | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const msgs = JSON.parse(raw);
    if (!Array.isArray(msgs)) return undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'user') return textOf(msgs[i].content);
    }
  } catch {
    /* malformed attribute — skip */
  }
  return undefined;
}

/** A model-message `content` (string or part array) flattened to its text. */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (Array.isArray(content)) {
    const t = content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
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
    const session = attrs[SESSION_META];
    if (typeof session !== 'string') return; // not one of our AI-SDK agent/job spans
    if (typeof attrs[SESSION_ID] !== 'string') set(SESSION_ID, session);

    const user = attrs[USER_META];
    if (typeof user === 'string' && typeof attrs[USER_ID] !== 'string') set(USER_ID, user);

    // Name from the primary turn/job operation — NOT the `delivery-recovery` checkpoint, which
    // runs within a turn and would otherwise hijack the trace name from `agent-turn`.
    const functionId = attrs[FUNCTION_ID];
    const isRecovery = typeof functionId === 'string' && functionId.startsWith('delivery-recovery');
    if (typeof functionId === 'string' && !isRecovery && typeof attrs[TRACE_NAME] !== 'string') {
      set(TRACE_NAME, functionId);
    }

    // Input = the user's message (constant across a turn's steps; the recovery checkpoint's prompt
    // has no user turn, so it contributes nothing).
    const input = lastUserText(attrs[PROMPT_MESSAGES]);
    if (input && typeof attrs[TRACE_INPUT] !== 'string') set(TRACE_INPUT, input.slice(0, MAX_IO));

    // Output = the DELIVERED reply: the `send_message` text on a turn/job (plain model text is
    // scratch, D-MG8), or the model text on the recovery checkpoint (which generates the reply).
    // Last non-empty wins → the final reply.
    const output = isRecovery
      ? modelText(attrs[RESPONSE_TEXT])
      : sendMessageText(attrs[RESPONSE_TOOLCALLS]);
    if (output) set(TRACE_OUTPUT, output.slice(0, MAX_IO));
  }
}
