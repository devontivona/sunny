import { generateText, type LanguageModel, type ModelMessage, type Tool } from 'ai';

/**
 * Delivery-recovery pass (messaging-gateway D-MG8).
 *
 * Runs only when the main turn produced text but called NEITHER `send_message`
 * nor `stay_silent` (an elicitation miss). A cheap model is FORCED to call one of
 * the two tools (`toolChoice: 'required'`) — composing a concise iMessage from the
 * model's private notes, or affirmatively choosing silence. It runs with no
 * extended thinking, which is the only way forced tool use is permitted on
 * Anthropic (forcing ⊥ thinking).
 *
 * The same `send_message` / `stay_silent` tool instances from the main turn are
 * reused, so a recovery send goes out the real gateway and bumps the same send
 * counter / silence flag the runner re-reads to re-classify the turn. Returns the
 * text of any recovery sends so the runner can record them in the turn history as
 * `send_message` tool calls (never as raw text).
 */
export interface RecoveryOptions {
  model: LanguageModel;
  ownerName: string;
  /** The turn's conversation (recent window), ending in the user message. */
  messages: ModelMessage[];
  /** The model's private notes/draft for the missed turn. */
  scratch: string;
  /** The live `send_message` + `stay_silent` tools (bound to counter/flag/gateway). */
  tools: Record<string, Tool>;
}

export async function runRecoveryPass(opts: RecoveryOptions): Promise<string[]> {
  const result = await generateText({
    model: opts.model,
    system: recoverySystem(opts.ownerName, opts.scratch),
    messages: opts.messages,
    tools: opts.tools,
    toolChoice: 'required',
  });

  return result.toolCalls
    .filter((c) => c.toolName === 'send_message')
    .map((c) => (c.input as { text?: string }).text)
    .filter((t): t is string => !!t);
}

function recoverySystem(ownerName: string, scratch: string): string {
  return [
    `You are the delivery checkpoint for Sunny, ${ownerName}'s iMessage assistant.`,
    `Sunny just finished a turn but sent NO message — it left its reply in private notes`,
    `instead of calling send_message, or it had nothing to say. Decide and act by calling`,
    `exactly ONE tool:`,
    `- If the notes contain something Sunny should actually say to ${ownerName}, call`,
    `  send_message with a clean, concise iMessage version of it (plain text, no markdown;`,
    `  trim to what's worth sending; keep it short — one or two messages at most).`,
    `- If nothing genuinely needs saying (${ownerName} just acknowledged, said thanks, or`,
    `  the notes are only private reasoning), call stay_silent.`,
    `Deliver what the notes already convey; do not invent new content.`,
    ``,
    `Sunny's private notes for this turn:`,
    scratch,
  ].join('\n');
}
