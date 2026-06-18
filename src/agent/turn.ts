import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import type { StoredMessage } from '../gateway/store.js';

/**
 * Pure turn helpers extracted from `loop.ts` (testability refactor D13, task 3.1).
 *
 * These hold the D-MG8 delivery logic and the D-MG9 stored-row → model-message
 * conversion as side-effect-free functions so they can be unit-tested directly,
 * without standing up the model, gateway, or DB. `runTurn` calls them; behavior
 * is unchanged.
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

/** The delivered messages of a turn: the `text` input of each `send_message` call. */
export function extractSends(parts: UIMessage['parts']): string[] {
  return parts
    .filter((p) => p.type === 'tool-send_message')
    .map((p) => (p as { input?: { text?: string } }).input?.text)
    .filter((t): t is string => !!t);
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
 * Convert the stored recent window (D-MG9) into model messages. Each row carries a
 * `UIMessage` payload — the real turn (scratch + tool calls incl. every
 * `send_message`) — so the converted history reflects what actually happened.
 * Legacy pre-D-MG9 rows (no payload) get a minimal reconstruction.
 */
export function toModelMessages(
  window: StoredMessage[],
  isGroup: boolean,
): Promise<ModelMessage[]> {
  const ui = window.map((row) => rowToUIMessage(row, isGroup));
  return convertToModelMessages(ui, { ignoreIncompleteToolCalls: true });
}

export function rowToUIMessage(row: StoredMessage, isGroup: boolean): Omit<UIMessage, 'id'> {
  if (row.payload && typeof row.payload === 'object') {
    const msg = row.payload as UIMessage;
    if (isGroup && msg.role === 'user' && row.senderName) return prefixUserMessage(msg, row);
    return msg;
  }
  // Legacy row (pre-D-MG9): minimal reconstruction.
  if (row.role === 'user') {
    const text = isGroup ? groupSpeakerPrefix(row.senderName, row.isOwner) + row.text : row.text;
    return { role: 'user', parts: [{ type: 'text', text }] };
  }
  return { role: 'assistant', parts: [{ type: 'text', text: row.text }] };
}

/** Prefix the speaker onto a group user message's text part(s) (R1). */
export function prefixUserMessage(msg: UIMessage, row: StoredMessage): UIMessage {
  const prefix = groupSpeakerPrefix(row.senderName, row.isOwner);
  return {
    ...msg,
    parts: msg.parts.map((p) => (p.type === 'text' ? { ...p, text: prefix + p.text } : p)),
  };
}
