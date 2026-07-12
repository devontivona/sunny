/**
 * In-run conversation history repair + accounting for the shared agent loop
 * (subagent-hardening, 2026-07-12).
 *
 * Upstream `@ai-sdk/workflow` (through at least 1.0.22) rebuilds the assistant message after a
 * tool-calls finish from the step's TOOL CALLS ONLY — any narration text the model generated in
 * the same step is silently dropped from the conversation prompt (dist `conversationPrompt`
 * assembly; contrast core `ai`'s `toResponseMessages`, which keeps text). The model therefore
 * never sees its own mid-run conclusions: the 2026-07-12 marathon child re-derived and
 * re-announced the same root cause 26 times over 5 hours without ever editing a file, because
 * every "found it, implementing now" it wrote had vanished from its next prompt.
 *
 * These helpers run inside `prepareStep` (whose returned messages REPLACE the loop's
 * conversation prompt) and are pure: same inputs → same outputs, so a WDK replay reconstructs
 * the identical prompt. They are generic over the message shape — the loop hands prepareStep
 * prompt-level messages, tests use `ModelMessage`; both satisfy the structural constraint.
 */

/** Minimal structural message shape these helpers touch. */
export interface PromptMessageLike {
  role: string;
  content: unknown;
  providerOptions?: unknown;
}

/** The step shape these helpers read — structural, matching AI SDK `StepResult` (usage in the
 *  v7 shape, loosened so partial/mock usage objects type-check). */
export interface StepContentLike {
  content: ReadonlyArray<{
    type: string;
    text?: string;
    toolCallId?: string;
  }>;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    inputTokenDetails?:
      | {
          noCacheTokens?: number | undefined;
          cacheReadTokens?: number | undefined;
          cacheWriteTokens?: number | undefined;
        }
      | undefined;
  };
}

type MessagePart = { type: string; text?: string; toolCallId?: string };

/**
 * Restore each step's narration TEXT into its assistant message in the conversation prompt.
 * Matching is by `toolCallId` (append-only prompt ⇒ ids are unique and stable); a message that
 * already carries a text part is left alone, so the repair is idempotent across the every-step
 * `prepareStep` calls. Text parts are placed BEFORE the tool calls, the order they were
 * generated in. Reasoning parts are NOT restored (signature-bound; the API rejects unsigned
 * replays) — text is the durable channel.
 */
export function restoreNarration<M extends PromptMessageLike>(
  messages: M[],
  steps: ReadonlyArray<StepContentLike>,
): { messages: M[]; changed: boolean } {
  const stepByCallId = new Map<string, StepContentLike>();
  for (const s of steps) {
    for (const p of s.content) {
      if (p.type === 'tool-call' && p.toolCallId) stepByCallId.set(p.toolCallId, s);
    }
  }
  if (stepByCallId.size === 0) return { messages, changed: false };

  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const parts = m.content as MessagePart[];
    if (parts.some((p) => p.type === 'text')) return m; // already restored (or a final reply)
    const firstCall = parts.find((p) => p.type === 'tool-call' && p.toolCallId);
    const step = firstCall?.toolCallId ? stepByCallId.get(firstCall.toolCallId) : undefined;
    if (!step) return m;
    const texts = step.content.filter((p) => p.type === 'text' && p.text?.trim());
    if (texts.length === 0) return m;
    changed = true;
    return {
      ...m,
      content: [...texts.map((t) => ({ type: 'text' as const, text: t.text as string })), ...parts],
    };
  });
  return changed ? { messages: out, changed } : { messages, changed: false };
}

/**
 * Move the incremental cache breakpoint to the last message, removing the one this function
 * set on a previous step (`prevIndex`; -1 for none). Anthropic caches the whole prefix up to a
 * breakpoint (tools + system included), so a breakpoint that tracks the growing tail turns a
 * multi-step run into write-the-delta + read-everything-before at 0.1× — without it every step
 * re-buys the full context at list price (the marathon's 108M uncached input tokens). Profile
 * statics (window-tail, compaction summary) sit at other indices and are never touched; the
 * provider enforces the 4-breakpoint ceiling.
 */
export function moveCacheBreakpoint<M extends PromptMessageLike>(
  messages: M[],
  prevIndex: number,
): { messages: M[]; index: number } {
  const last = messages.length - 1;
  if (last < 0) return { messages, index: prevIndex };
  const out = [...messages];
  if (prevIndex >= 0 && prevIndex < last) {
    const prev = out[prevIndex];
    if (prev) out[prevIndex] = withoutCacheControl(prev);
  }
  if (prevIndex !== last) out[last] = withCacheControl(out[last]!);
  return { messages: out, index: last };
}

type AnthropicOptions = Record<string, unknown> | undefined;

function withCacheControl<M extends PromptMessageLike>(m: M): M {
  const provider = (m.providerOptions ?? {}) as Record<string, unknown>;
  return {
    ...m,
    providerOptions: {
      ...provider,
      anthropic: {
        ...(provider.anthropic as AnthropicOptions),
        cacheControl: { type: 'ephemeral' },
      },
    },
  };
}

function withoutCacheControl<M extends PromptMessageLike>(m: M): M {
  const provider = (m.providerOptions ?? {}) as Record<string, unknown>;
  const anthropic = { ...(provider.anthropic as AnthropicOptions) };
  delete anthropic.cacheControl;
  return { ...m, providerOptions: { ...provider, anthropic } };
}

/** Dollar rates per MILLION tokens for {@link estimateStepsCostUsd}. */
export interface TokenRatesUsdPerMtok {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * Estimate the dollars a run of steps has spent from per-step usage (v7 `LanguageModelUsage`:
 * `inputTokens` is the cached-inclusive total, the split lives in `inputTokenDetails`).
 * Defensive on partial usage: with no details, ALL input prices at the cache-write rate — on a
 * hard budget, overcounting beats undercounting.
 */
export function estimateStepsCostUsd(
  steps: ReadonlyArray<StepContentLike>,
  rates: TokenRatesUsdPerMtok,
): number {
  let usd = 0;
  for (const s of steps) {
    const u = s.usage;
    if (!u) continue;
    const input = u.inputTokens ?? 0;
    const d = u.inputTokenDetails;
    const read = Math.min(d?.cacheReadTokens ?? 0, input);
    const write = Math.min(d?.cacheWriteTokens ?? 0, input - read);
    const noCache = d?.noCacheTokens ?? Math.max(0, input - read - write);
    const output = u.outputTokens ?? 0;
    usd +=
      (read * rates.cacheRead +
        write * rates.cacheWrite +
        noCache * (d ? rates.input : rates.cacheWrite) +
        output * rates.output) /
      1e6;
  }
  return usd;
}
