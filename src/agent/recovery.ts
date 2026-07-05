import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { telemetryEnabled } from '../observability/instrumentation.js';

/**
 * Abnormal-turn-end backstop.
 *
 * Under text-as-reply (PR #31) a deliberate turn always ends on reply text or the
 * `<no-reply/>` silence sentinel — so this pass runs only when a turn ended
 * ABNORMALLY with working notes but no reply: the step limit cut it off mid-task,
 * a `length`/`content-filter`/`error` finish killed the generation, or (rare) an
 * empty final. Rather than ghosting the user, a cheap utility model composes an
 * honest status message from the turn's notes ("here's where I got"), which the
 * runner delivers and persists as the turn's final reply text. It fired ZERO times
 * across the PR #31 gate runs — this is tail insurance, and how often it fires in
 * production is itself a tracked signal (Langfuse functionId `turn-backstop`).
 *
 * Historical note: this began life as the D-MG8 "delivery-recovery" pass, rescuing
 * tool-mode elicitation misses (replies written into scratch instead of
 * send_message). The text migration removed that disease by construction; the
 * mechanism survives with a smaller job. Two hard-won lessons carry over:
 * plain-text output (never a forced tool call — the old `toolChoice: 'required'`
 * pass resolved without a usable call, ghosting while reporting success), and the
 * third-person transcript framing (below).
 *
 * The backstop has NO "stay silent" option: by the time it runs the turn did real
 * work worth accounting for, so it always composes.
 */
export interface BackstopOptions {
  model: LanguageModel;
  ownerName: string;
  /** The turn's conversation (recent window), ending in the user message. */
  messages: ModelMessage[];
  /** The cut-off turn's working notes (interim narration; never delivered raw). */
  notes: string;
  /** The turn's thread id, so the backstop span groups with that turn's session. */
  threadId: string;
}

/**
 * Render the turn's messages as a labeled, third-person TRANSCRIPT for the backstop
 * model — `Devon: …` / `Sunny (said): …` / `Sunny [ran bash: …]` — to be embedded in
 * a single user message rather than replayed as native assistant/tool turns.
 *
 * Why this shape is load-bearing: fed the raw trajectory as its own assistant/tool
 * turns, the Haiku backstop call identifies AS Sunny and tries to CONTINUE the task
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
export function renderTranscript(
  messages: ModelMessage[],
  ownerName: string,
  // Prior turns' plain text WAS the delivered reply under text-as-reply; legacy rows'
  // send_message tool calls still render as `Sunny (sent):` below.
  assistantTextLabel = 'said',
): string {
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
          lines.push(`Sunny (${assistantTextLabel}): ${(p.text as string).trim()}`);
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

/** Compose the status message the cut-off turn should send. Empty = nothing to send. */
export async function runBackstopPass(opts: BackstopOptions): Promise<string> {
  const transcript = renderTranscript(opts.messages, opts.ownerName);
  const userMessage =
    `Conversation transcript:\n${transcript}\n\n` +
    `Sunny's working notes for the latest turn (which was cut off before it wrote its reply):\n${opts.notes}\n\n` +
    `Write the message Sunny should send to ${opts.ownerName} now.`;
  const result = await generateText({
    model: opts.model,
    instructions: backstopSystem(opts.ownerName),
    messages: [{ role: 'user', content: userMessage }],
    // Trace the backstop too (observability D-OB1) — how often this path fires is itself
    // a signal worth watching (an abnormal turn end). Linked to the turn's session via
    // threadId. (Renamed from functionId 'delivery-recovery' on 2026-07-05.)
    runtimeContext: {
      recovery: true,
      trigger: 'abnormal-turn-end',
      langfuseSessionId: opts.threadId,
    },
    telemetry: {
      isEnabled: telemetryEnabled(),
      functionId: 'turn-backstop',
      includeRuntimeContext: { recovery: true, trigger: true, langfuseSessionId: true },
    },
  });
  return result.text.trim();
}

function backstopSystem(ownerName: string): string {
  return [
    `You are the safety net for ${ownerName}'s iMessage assistant, Sunny. Sunny's turn was`,
    `CUT OFF mid-task (it ran out of steps or hit an error) before it wrote its reply — so`,
    `${ownerName} would otherwise hear nothing. You are given the recent conversation`,
    `TRANSCRIPT plus Sunny's working notes for the cut-off turn; write the honest message`,
    `Sunny should send now, in Sunny's voice (warm, concise, first person).`,
    `- You are NOT Sunny and you are NOT continuing the task — only report where things`,
    `  stand, drawn from the notes.`,
    `- If the notes contain a finished result, deliver it. If the work is clearly`,
    `  UNFINISHED, say so honestly — what got done, what didn't — and never claim or imply`,
    `  the task completed. Do not promise Sunny will keep working; the turn is over, so`,
    `  invite ${ownerName} to nudge if they want it picked back up.`,
    `- Plain text, no markdown. Concise — one or two short messages at most.`,
    `- Deliver what the notes already convey; do not invent new content.`,
    `- Output ONLY the message text Sunny should send — no preamble, no quotes, nothing else.`,
  ].join('\n');
}
