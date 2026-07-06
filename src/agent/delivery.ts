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

/** How a turn's reply reached (or didn't reach) the user. `text` — the final text
 *  delivered directly as bubbles (the one live path); `fallback_text` — an abnormal
 *  turn end the backstop composes from; `silence` — the deliberate no-reply.
 *  `send_message` survives only as a READ value: rows persisted before the 2026-07
 *  text-delivery migration carry it in their metadata. */
export type Delivery = 'send_message' | 'text' | 'fallback_text' | 'silence';

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
export function assistantUIMessageFromResponse(
  messages: ModelMessage[],
  /** Insertion hook (translator chronology): called with each assistant message's index
   *  (== the step number — the caller builds one assistant message per step) BEFORE that
   *  step's parts are appended, so injected parts land at their true chronological spot. */
  beforeAssistant?: (stepIndex: number) => UIMessage['parts'],
): UIMessage | undefined {
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
  let stepIndex = -1;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    stepIndex += 1;
    if (beforeAssistant) parts.push(...beforeAssistant(stepIndex));
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

/** All `text` parts of a turn, joined and trimmed (a legacy turn's private scratch;
 *  used with slicing for a live turn's interim/final split — see extractFinalText). */
export function extractScratch(parts: UIMessage['parts']): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * Text-as-reply extraction (text delivery mode): the FINAL text is everything the
 * model wrote AFTER its last tool call — the reply that gets delivered as bubbles.
 * A turn with no tool parts is all final. Text at/before the last tool part is
 * INTERIM narration (the translator's source material; see extractInterimText).
 */
export function extractFinalText(parts: UIMessage['parts']): string {
  return extractScratch(parts.slice(lastToolIndex(parts) + 1));
}

/** The interim narration of a text-mode turn: text parts at/before the last tool part. */
export function extractInterimText(parts: UIMessage['parts']): string {
  return extractScratch(parts.slice(0, lastToolIndex(parts) + 1));
}

/** Index of the last `tool-*` part, or -1 (data-* parts don't count — they're not turns
 *  of work, so translator updates never shift the final/interim boundary). */
function lastToolIndex(parts: UIMessage['parts']): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.type.startsWith('tool-')) return i;
  }
  return -1;
}

/**
 * Text-mode silence sentinel: the model chooses silence by making this token its ENTIRE
 * reply. Silence-by-sentinel goes WITH the trained "end the turn with text" prior instead
 * of fighting it — the 2026-07-04 grid showed the model inventing its own sentinels
 * ("(silent)", "(no reply needed)") 9/9 when told to end with nothing, and the translator's
 * NO_UPDATE sentinel has been reliable on the same job. A weird verbatim token (not a
 * natural-language sentence) so it never drifts into paraphrase the parser would miss.
 */
export const NO_REPLY_SENTINEL = '<no-reply/>';

/** The delegated child's silence sentinel: a final text of exactly this delivers nothing
 *  to the parent ("your orchestrator needs nothing from this"). Distinct from
 *  NO_REPLY_SENTINEL so telemetry and prompt language stay unambiguous. */
export const NO_REPORT_SENTINEL = '<no-report/>';

/**
 * Parse a silence sentinel out of a final text. `sentinel` reports whether it appeared;
 * `text` is what remains. A final that is ONLY the sentinel parses to silence; real
 * content alongside a (stray) sentinel is delivered with the token stripped — nothing
 * genuinely written is ever swallowed.
 */
export function stripSentinel(
  finalText: string,
  token: string,
): { text: string; sentinel: boolean } {
  if (!finalText.includes(token)) return { text: finalText, sentinel: false };
  return { text: finalText.split(token).join('').trim(), sentinel: true };
}

/** The conversation turn's silence parse (see NO_REPLY_SENTINEL). */
export function stripNoReply(finalText: string): { text: string; sentinel: boolean } {
  return stripSentinel(finalText, NO_REPLY_SENTINEL);
}

/** The delegated child's silence parse (see NO_REPORT_SENTINEL). */
export function stripNoReport(finalText: string): { text: string; sentinel: boolean } {
  return stripSentinel(finalText, NO_REPORT_SENTINEL);
}

/**
 * Extract complete `<report>…</report>` blocks from a child's text (subagent
 * text-unification): mid-task progress a child deliberately writes for its orchestrator.
 * Returns each block's trimmed content plus the text with those blocks removed. Only
 * COMPLETE pairs count — an unterminated `<report>` stays in the text as-is, so a
 * half-written block is never partially delivered.
 */
export function extractReportBlocks(text: string): { reports: string[]; rest: string } {
  const reports: string[] = [];
  const rest = text
    .replace(/<report>([\s\S]*?)<\/report>/g, (_, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) reports.push(trimmed);
      return '';
    })
    .trim();
  return { reports, rest };
}

/**
 * Classify a TEXT-mode turn from its extracted signals. Callers pass the final text
 * AFTER `stripNoReply` (a sentinel-only reply arrives here as empty + silent=true).
 * Final text wins FIRST — by design: the stay_silent-spam pathology (PR #30
 * transcripts) showed the model can write a real reply and ALSO signal silence; when
 * final text exists it is the reply and must be delivered, never swallowed.
 *
 * - final text present → `text` (delivered directly as bubbles)
 * - no final, silence signaled (sentinel; or a legacy row's stay_silent call) → `silence`
 * - no final, interim narration only → `fallback_text` (the empty-final miss; the
 *   recovery backstop composes the reply from the narration)
 * - no final/interim but an ABNORMAL finish (step-limit / length / error) → `fallback_text`:
 *   a thinking turn can do real tool work while writing nothing (reasoning is dropped and
 *   tool-call parts aren't interim text), so an abnormal end with nothing delivered is the
 *   empty-final miss too — it must route to the backstop, NOT be swallowed as a no-reply.
 * - nothing at all, finished normally → `silence`
 *
 * `finishReason` is the last step's finish reason (`result.finishReason`); undefined is
 * treated as a normal finish so legacy 3-arg callers keep their prior behavior.
 */
export function classifyTextDelivery(
  finalText: string,
  interimText: string,
  staySilent: boolean,
  finishReason?: string,
): Delivery {
  if (finalText) return 'text';
  if (staySilent) return 'silence';
  if (interimText) return 'fallback_text';
  // A deliberate turn ends on `stop` (reply text or the silence sentinel). Any other finish
  // with nothing delivered is abnormal — treat it as the empty-final miss, not silence.
  if (finishReason && finishReason !== 'stop') return 'fallback_text';
  return 'silence';
}

/**
 * Build a `data-translator` UIMessage part recording one relayed progress update
 * (text mode). Persisted in the turn row (same `data-*` convention as
 * `data-attachment`); rendered attributed or stripped at READ time per
 * `config.translatorHistory` — see `renderTranslatorParts` in turn.ts.
 */
export function translatorPart(text: string, step: number): UIMessage['parts'][number] {
  return { type: 'data-translator', data: { text, step } } as UIMessage['parts'][number];
}

/** The relayed translator updates persisted on a turn, in order. */
export function extractTranslatorUpdates(
  parts: UIMessage['parts'],
): { text: string; step: number }[] {
  return parts
    .filter((p) => p.type === 'data-translator')
    .map((p) => (p as { data?: { text?: string; step?: number } }).data)
    .filter((d): d is { text: string; step: number } => typeof d?.text === 'string');
}

/** LEGACY-ROW helper: the delivered bubbles of a pre-text-migration turn (each
 *  `send_message` call's text input). Read paths only — no live turn produces these. */
export function extractSends(parts: UIMessage['parts']): string[] {
  return parts
    .filter((p) => p.type === 'tool-send_message')
    .map((p) => (p as { input?: { text?: string } }).input?.text)
    .filter((t): t is string => !!t);
}

/** LEGACY-ROW helper: whether a pre-text-migration turn chose silence via the old
 *  `stay_silent` tool. Read paths only. */
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
 * Render a steered/folded-in message's text for a model `user` turn (D-DE steering;
 * task 1.3). In a group, prefix the sender name so the model can follow who said what
 * (R1); in a DM, the text passes through unchanged.
 */
export function steerMessageText(
  text: string,
  senderName: string | undefined,
  isGroup: boolean,
): string {
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
