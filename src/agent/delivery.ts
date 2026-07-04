import type { LanguageModelUsage, ModelMessage, UIMessage } from 'ai';

/**
 * Pure, side-effect-free turn/delivery helpers (D-MG8/D-MG9), split out of `turn.ts`
 * so they carry NO `node:*` imports and are safe to import from workflow/orchestrator
 * code that loads in the WDK sandbox (where Node modules are unavailable) — the same
 * convention `bashSpecs.ts` / `memorySpecs.ts` follow. The in-process loop and the
 * durable conversational workflow share these so the two tiers can never drift on
 * delivery classification, steer folding, or the persisted turn shape.
 *
 * `turn.ts` re-exports everything here, so existing `./turn.js` imports keep working;
 * the media-resolution helpers that DO touch the filesystem stay in `turn.ts`.
 */

/** How a turn's reply reached (or didn't reach) the user (D-MG8). */
export type Delivery = 'send_message' | 'fallback_text' | 'silence';

/**
 * Classify how a turn was delivered from three observable signals: how many times
 * `send_message` was called, whether the model affirmatively called `stay_silent`,
 * and whether any private scratch text exists.
 *
 * - `send_message` — the intended path: the model spoke via the tool.
 * - `silence` — a deliberate, valid choice: the model called `stay_silent`, OR it
 *   produced nothing at all (no send, no scratch).
 * - `fallback_text` — an elicitation MISS: the model wrote private scratch but
 *   called NEITHER `send_message` nor `stay_silent`. This is what triggers the
 *   recovery pass (and, if recovery is somehow skipped, what gets logged as the
 *   regression signal). Raw scratch is never delivered as-is.
 *
 * From the user's perspective `silence` and an unrecovered `fallback_text` both
 * mean "no message arrived"; they are kept distinct purely as telemetry.
 */
export function classifyDelivery(sendCount: number, scratch: string, staySilent = false): Delivery {
  if (sendCount > 0) return 'send_message';
  if (staySilent) return 'silence';
  if (scratch) return 'fallback_text';
  return 'silence';
}

/**
 * Trim trailing non-user messages (assistant + tool) back to the last user
 * message. Anthropic rejects a prompt that ends on an assistant message, and the
 * stored window is insertion-ordered (D-MG9), so a turn record can leave trailing
 * assistant/tool messages. Returns a new array; does not mutate the input.
 */
export function trimTrailingNonUser(messages: ModelMessage[]): ModelMessage[] {
  const out = messages.slice();
  while (out.length > 0 && out[out.length - 1]?.role !== 'user') {
    out.pop();
  }
  return out;
}

/**
 * Reconstruct the turn's single assistant `UIMessage` from a `WorkflowAgent` result's
 * `ModelMessage[]` (D-MG9, AI SDK v7). v6 `DurableAgent.stream({ collectUIMessages: true })`
 * gave us `result.uiMessages`; v7 removed `collectUIMessages`, so we rebuild the same shape
 * the persistence + delivery classification expect: ALL assistant content across steps merged
 * into one UIMessage (`text` scratch parts + `tool-<name>` parts), with each tool part's
 * `output` matched from the corresponding `tool`-role result message. Reasoning/file parts are
 * dropped (reasoning is private and re-sending it is rejected by Anthropic — see `stripReasoning`).
 * Returns undefined when the turn produced no assistant message.
 */
export function assistantUIMessageFromResponse(messages: ModelMessage[]): UIMessage | undefined {
  const outputs = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const p of m.content as Array<Record<string, unknown>>) {
      if (p.type === 'tool-result') outputs.set(p.toolCallId as string, unwrapToolOutput(p.output));
    }
  }
  const parts: UIMessage['parts'] = [];
  const seenToolCallIds = new Set<string>();
  let sawAssistant = false;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    sawAssistant = true;
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ type: 'text', text: m.content } as UIMessage['parts'][number]);
      continue;
    }
    for (const p of m.content as Array<Record<string, unknown>>) {
      if (p.type === 'text') {
        parts.push({ type: 'text', text: p.text as string } as UIMessage['parts'][number]);
      } else if (p.type === 'tool-call') {
        const id = p.toolCallId as string;
        // Defense-in-depth: never emit the same tool-call id twice. A duplicate `tool_use` id
        // makes Anthropic reject the whole prompt ("`tool_use` ids must be unique") on EVERY
        // later turn, poisoning the thread so it can never make progress. The caller should pass
        // only this turn's generated messages; this guard guarantees a valid row regardless.
        if (seenToolCallIds.has(id)) continue;
        seenToolCallIds.add(id);
        parts.push({
          type: `tool-${p.toolName as string}`,
          toolCallId: id,
          state: 'output-available',
          input: p.input,
          output: outputs.has(id) ? outputs.get(id) : 'ok',
        } as UIMessage['parts'][number]);
      }
      // reasoning / file parts intentionally dropped (see doc above).
    }
  }
  return sawAssistant ? { id: 'turn', role: 'assistant', parts } : undefined;
}

/** Unwrap a v7 tool-result `output` ({ type, value }) to its plain value for the persisted
 *  UIMessage part (history round-trips via `convertToModelMessages`); pass through anything else. */
function unwrapToolOutput(output: unknown): unknown {
  if (output && typeof output === 'object' && 'value' in output && 'type' in output) {
    return (output as { value: unknown }).value;
  }
  return output;
}

/** The private scratchpad text of a turn: all `text` parts, joined and trimmed. */
export function extractScratch(parts: UIMessage['parts']): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * Build a `tool-send_message` UIMessage part for a delivered message. Used to
 * record a recovery-pass send (which happens in a separate model call) into the
 * turn's history as a `send_message` tool call — the same shape the main loop
 * persists — so the next turn's context reinforces "speaking == send_message".
 */
export function sendMessagePart(text: string, toolCallId: string): UIMessage['parts'][number] {
  return {
    type: 'tool-send_message',
    toolCallId,
    state: 'output-available',
    input: { text },
    output: 'delivered',
  } as UIMessage['parts'][number];
}

/**
 * Split a reply into iMessage bubbles on blank lines (text delivery mode). A reply
 * with no blank line is one bubble; empty/whitespace yields no bubbles.
 */
export function splitBubbles(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The delivered messages of a turn: the `text` input of each `send_message` call. */
export function extractSends(parts: UIMessage['parts']): string[] {
  return parts
    .filter((p) => p.type === 'tool-send_message')
    .map((p) => (p as { input?: { text?: string } }).input?.text)
    .filter((t): t is string => !!t);
}

/** Whether the turn affirmatively chose silence (a `stay_silent` tool call, D-MG8). */
export function calledStaySilent(parts: UIMessage['parts']): boolean {
  return parts.some((p) => p.type === 'tool-stay_silent');
}

/**
 * Speaker prefix for a group user message (R1) — e.g. `Devon (owner): ` — so the
 * model can follow who said what. Empty string when there's no sender name.
 */
export function groupSpeakerPrefix(senderName: string | undefined, isOwner: boolean): string {
  if (!senderName) return '';
  return `${senderName}${isOwner ? ' (owner)' : ''}: `;
}

/**
 * Relay envelope for an inbound user message (elicitation experiment,
 * `config.inboundEnvelope`) — e.g. `[iMessage from Devon] `. Marks EVERY user
 * message (DM and group) as having arrived via a channel relay, reinforcing at
 * the RECENT end of the context — where instructions actually win in long
 * threads — that replies travel back the same way (send_message), not as raw
 * conversation text. Token-lean on purpose. The `(owner)` tag only matters where
 * senders can differ (groups), matching `groupSpeakerPrefix`.
 */
export function envelopePrefix(
  senderName: string | undefined,
  isOwner: boolean,
  isGroup: boolean,
): string {
  if (!senderName) return '[iMessage] ';
  return `[iMessage from ${senderName}${isGroup && isOwner ? ' (owner)' : ''}] `;
}

/** The prefix for an inbound user message under the active config: envelope when
 *  enabled (all threads), else the group speaker prefix (groups only). */
export function userMessagePrefix(
  senderName: string | undefined,
  isOwner: boolean,
  isGroup: boolean,
  envelope: boolean,
): string {
  if (envelope) return envelopePrefix(senderName, isOwner, isGroup);
  return isGroup ? groupSpeakerPrefix(senderName, isOwner) : '';
}

/**
 * Render a steered/folded-in message's text for a model `user` turn (D-DE steering;
 * task 1.3). In a group, prefix the sender name so the model can follow who said what
 * (R1); in a DM, the text passes through unchanged. The shared seam used by both the
 * in-process loop's `prepareStep` and the durable workflow's queue drain — the only
 * thing that differs between tiers is the feed (in-process push vs. hook resume) and
 * the `ModelMessage` vs. `LanguageModelV3Prompt` shape each wraps this text in.
 */
export function steerMessageText(
  text: string,
  senderName: string | undefined,
  isGroup: boolean,
  envelope = false,
): string {
  // Envelope mode wraps steers too, so mid-turn arrivals read like every other
  // relayed message. (Steer rows don't carry `isOwner`; the group owner tag is
  // a group-disambiguation nicety, not a correctness bit, so it's omitted here.)
  if (envelope) return envelopePrefix(senderName, false, isGroup) + text;
  return isGroup && senderName ? `${senderName}: ${text}` : text;
}

/** Per-turn token usage in the persisted/live shape (mirrors observability RunUsage). */
export interface TurnUsage {
  in: number | null;
  out: number | null;
  cached: number | null;
  cacheWrite: number | null;
}

/** Flatten an AI-SDK `LanguageModelUsage` to the persisted/live usage shape (D-MG9). */
export function usageOf(totalUsage: LanguageModelUsage): TurnUsage {
  return {
    in: totalUsage.inputTokens ?? null,
    out: totalUsage.outputTokens ?? null,
    cached: totalUsage.inputTokenDetails?.cacheReadTokens ?? null,
    cacheWrite: totalUsage.inputTokenDetails?.cacheWriteTokens ?? null,
  };
}

/**
 * Build the one-row-per-turn record (D-MG9, task 1.2) from the assembled assistant
 * `UIMessage` and its (possibly recovery-augmented) parts, stamping the turn metadata
 * — model, usage, delivery path, recovery flag, step count — that the dashboard and
 * recall read. Shared by both tiers so the persisted shape is identical regardless of
 * which path produced the turn.
 */
export function buildTurnRecord(
  assistant: UIMessage,
  parts: UIMessage['parts'],
  meta: {
    model: string;
    usage: TurnUsage;
    delivered: Delivery;
    recovered: boolean;
    steps: number;
    createdAt?: string;
  },
): UIMessage {
  return {
    ...assistant,
    parts,
    metadata: {
      ...(assistant.metadata as Record<string, unknown> | undefined),
      createdAt: meta.createdAt ?? new Date().toISOString(),
      model: meta.model,
      usage: meta.usage,
      delivered: meta.delivered,
      recovered: meta.recovered,
      steps: meta.steps,
    },
  };
}
