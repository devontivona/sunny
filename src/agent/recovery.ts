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
 * delivers it. With the transcript framing (below) an empty result should be
 * impossible; the runner treats one as a CRITICAL error rather than silently
 * dropping the turn.
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
 * Render the turn's messages as a labeled, third-person TRANSCRIPT for the recovery
 * model — `Devon: …` / `Sunny (sent): …` / `Sunny [ran bash: …]` — to be embedded in
 * a single user message rather than replayed as native assistant/tool turns.
 *
 * Why this shape is load-bearing: fed the raw trajectory as its own assistant/tool
 * turns, the Haiku recovery call identifies AS Sunny and tries to CONTINUE the task
 * (given a tool it emits another `bash`/`agent-browser` call to "finish fetching");
 * with no tools defined — the real recovery call — that impulse collapses into an
 * empty `stop` turn, which is the production ghosting bug. Presenting the history as
 * an OBSERVED transcript removes that self-identification, and annotating the tool
 * calls (simplified — what Sunny ran, not the raw output) keeps the useful signal a
 * plain text-only strip would throw away. Verified on a captured miss: transcript
 * form → a real reply every time; raw trajectory → empty every time.
 *
 * Reasoning (thinking) blocks and raw tool-result payloads are intentionally omitted.
 */
export function renderTranscript(messages: ModelMessage[], ownerName: string): string {
  const brief = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  };
  const lines: string[] = [];
  for (const m of messages) {
    const parts = Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>)
      : [{ type: 'text', text: m.content as string }];
    if (m.role === 'user') {
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text as string)
        .join(' ')
        .trim();
      if (text) lines.push(`${ownerName}: ${text}`);
      if (parts.some((p) => p.type === 'file' || p.type === 'image')) {
        lines.push(`${ownerName}: [sent an attachment]`);
      }
    } else if (m.role === 'assistant') {
      for (const p of parts) {
        if (p.type === 'text' && (p.text as string)?.trim()) {
          lines.push(`Sunny (private note): ${(p.text as string).trim()}`);
        } else if (p.type === 'tool-call') {
          const input = p.input as Record<string, unknown> | undefined;
          if (p.toolName === 'send_message') {
            lines.push(`Sunny (sent): ${(input?.text as string) ?? ''}`);
          } else {
            lines.push(`Sunny [ran ${p.toolName as string}: ${brief(input?.command ?? input)}]`);
          }
        }
      }
    }
  }
  return lines.join('\n');
}

/** Compose the clean iMessage the missed turn should have sent. Empty = nothing to send. */
export async function runRecoveryPass(opts: RecoveryOptions): Promise<string> {
  const transcript = renderTranscript(opts.messages, opts.ownerName);
  const userMessage =
    `Conversation transcript:\n${transcript}\n\n` +
    `Sunny's private draft notes for the latest turn (the reply it failed to send):\n${opts.scratch}\n\n` +
    `Write the message Sunny should send to ${opts.ownerName} now.`;
  const result = await generateText({
    model: opts.model,
    instructions: recoverySystem(opts.ownerName),
    messages: [{ role: 'user', content: userMessage }],
    // Trace the recovery pass too (observability D-OB1), tagged as a recovery so it is
    // filterable in Langfuse — how often this path fires is itself a signal worth watching
    // (the elicitation miss it backstops; D-MG8). Linked to the turn's session via threadId.
    // v7 carries metadata via runtimeContext (the v6 telemetry.metadata channel was removed).
    runtimeContext: {
      recovery: true,
      trigger: 'elicitation-miss',
      langfuseSessionId: opts.threadId,
    },
    telemetry: {
      isEnabled: telemetryEnabled(),
      functionId: 'delivery-recovery',
      includeRuntimeContext: { recovery: true, trigger: true, langfuseSessionId: true },
    },
  });
  return result.text.trim();
}

function recoverySystem(ownerName: string): string {
  return [
    `You are the delivery checkpoint for ${ownerName}'s iMessage assistant, Sunny.`,
    `Sunny just finished a turn but its reply never went out — it left the reply in its`,
    `private draft notes instead of sending it. You are given the recent conversation`,
    `TRANSCRIPT plus those notes; write the clean iMessage Sunny should send to ${ownerName} now.`,
    `- You are NOT Sunny and you are NOT continuing the task — only compose the message`,
    `  Sunny already meant to send, drawn from its notes.`,
    `- The notes are written incrementally across the turn and may mix interim progress`,
    `  ("on it", "one moment", "give me a few minutes") with the final result. Send the`,
    `  message that reflects the FINAL state: if the work is already done, deliver the`,
    `  completed result and DROP the earlier progress / "working on it" lines — by the time`,
    `  this sends the work is finished, so a "give me a minute" line would contradict it.`,
    `- Plain text, no markdown. Concise — one or two short messages at most.`,
    `- Deliver what the notes already convey; do not invent new content.`,
    `- Output ONLY the message text Sunny should send — no preamble, no quotes, nothing else.`,
  ].join('\n');
}
