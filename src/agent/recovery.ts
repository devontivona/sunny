import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { telemetryEnabled } from '../observability/instrumentation.js';

/**
 * Delivery-recovery pass (messaging-gateway D-MG8).
 *
 * Runs only when the main turn produced text but never delivered it (an
 * elicitation miss). A cheap model rewrites the agent's private notes into a clean
 * iMessage and returns it as PLAIN TEXT — no tool call, no forced tool use. The
 * runner then delivers that text and records it in history as a `send_message`
 * tool call, so a recovered miss is indistinguishable from a clean send and
 * reinforces the positive pattern.
 *
 * Why plain text and not a forced tool call: generating text is the single most
 * reliable thing the model does. The old `toolChoice: 'required'` pass was fragile
 * (incompatible with extended thinking on Anthropic) and in production resolved
 * without ever emitting a usable tool call — ghosting the user while reporting it
 * had recovered. Removing the forcing removes that whole failure class.
 *
 * The backstop has NO "stay silent" option: choosing silence is the main turn's
 * job (via `stay_silent`). By the time the backstop runs the model has already
 * written a reply it simply failed to send, so the backstop always composes and
 * delivers it. An empty result means "nothing to send" and the runner delivers
 * nothing.
 */
export interface RecoveryOptions {
  model: LanguageModel;
  ownerName: string;
  /** The turn's conversation (recent window), ending in the user message. */
  messages: ModelMessage[];
  /** The model's private notes/draft for the missed turn. */
  scratch: string;
  /** The turn's thread id, so the recovery span groups with that turn's session. */
  threadId: string;
}

/**
 * Reduce the turn's messages to PLAIN TEXT only — drop tool-call / tool-result /
 * reasoning (thinking) parts, keeping each message's text content. The recovery
 * model only needs the conversational context plus the scratch (in its system
 * prompt), not the tool trajectory.
 *
 * This is load-bearing, not cosmetic. Fed the raw trajectory, the Haiku recovery
 * call reads the assistant/tool turns as ITS OWN ongoing agent session and tries to
 * CONTINUE the task rather than rewrite the scratch — given a tool it emits another
 * `bash`/`agent-browser` call to "finish fetching"; with no tools defined (the real
 * recovery call) that impulse resolves to an EMPTY `stop` turn instead of plain
 * text. That is the production ghosting bug (verified by replaying a captured miss:
 * raw trajectory → empty every time, `finish=stop`; text-only → a real reply every
 * time). Stripping the tool-call/tool-result/reasoning parts removes the agentic
 * framing, so the conversation reads as a plain dialogue and the model follows the
 * "write the message" instruction. Keeps the backstop reliable regardless of how
 * rich the turn's trajectory was.
 */
export function sanitizeForRecovery(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content.trim()) out.push(m);
      continue;
    }
    const text = (m.content as Array<{ type: string }>).filter((p) => p.type === 'text');
    if (text.length > 0) out.push({ ...m, content: text } as ModelMessage);
  }
  return out;
}

/** Compose the clean iMessage the missed turn should have sent. Empty = nothing to send. */
export async function runRecoveryPass(opts: RecoveryOptions): Promise<string> {
  const result = await generateText({
    model: opts.model,
    system: recoverySystem(opts.ownerName, opts.scratch),
    messages: sanitizeForRecovery(opts.messages),
    // Trace the recovery pass too (observability D-OB1), tagged as a recovery so
    // it is filterable in Langfuse — how often this path fires is itself a signal
    // worth watching (the elicitation miss it backstops; D-MG8). Linked to the
    // turn's session via threadId. No-op when tracing is disabled.
    experimental_telemetry: {
      isEnabled: telemetryEnabled(),
      functionId: 'delivery-recovery',
      metadata: {
        recovery: true,
        trigger: 'elicitation-miss',
        langfuseSessionId: opts.threadId,
      },
    },
  });
  return result.text.trim();
}

function recoverySystem(ownerName: string, scratch: string): string {
  return [
    `You are the delivery checkpoint for Sunny, ${ownerName}'s iMessage assistant.`,
    `Sunny just finished a turn but its reply never went out — it left the reply in its`,
    `private notes instead of sending it. Your job: write the clean iMessage version of`,
    `what Sunny should say to ${ownerName} now, drawn from those notes.`,
    `- Plain text, no markdown. Concise — one or two short messages at most.`,
    `- Deliver what the notes already convey; do not invent new content.`,
    `- Output ONLY the message text Sunny should send — no preamble, no quotes, nothing else.`,
    ``,
    `Sunny's private notes for this turn:`,
    scratch,
  ].join('\n');
}
