import { generateText, type LanguageModel } from 'ai';
import { telemetryEnabled } from '../observability/instrumentation.js';

/**
 * Interim-progress translator (text-delivery migration, Phase 3).
 *
 * On a long tool-using turn the primary model narrates as it works (its interim text);
 * this pass has a cheap model relay that narration to the user as a short progress
 * update — the "on it — starting with X" beat — every N steps. It is the recovery
 * pass's sibling: the same third-person transcript-style framing (the load-bearing
 * recovery.ts lesson — fed the trajectory as its own turns, Haiku identifies AS Sunny
 * and tries to continue the task; presented an OBSERVED account, it just writes the
 * message), pointed at progress instead of a missed reply.
 *
 * SILENCE IS THE DEFAULT: the translator declines (returns '') whenever the notes
 * carry no user-relevant news — internal bookkeeping, a step that found nothing yet,
 * or nothing beyond what the last update already said. An over-chatty translator is a
 * worse failure than a quiet one; the final reply always arrives regardless.
 */
export interface TranslatorOptions {
  model: LanguageModel;
  /** Whom the update is relayed to (the thread's subject — the owner, or the family
   *  member in an owner-absent thread). */
  subject: string;
  /** The primary model's working notes since the last update (never delivered raw):
   *  narration text it wrote plus `[ran <tool>: …]` lines for its tool calls. */
  interim: string;
  /** The last few updates already relayed, oldest first (so news isn't repeated). */
  recentUpdates: string[];
  /** The turn's thread id, so the span groups with that turn's Langfuse session. */
  threadId: string;
}

/** The exact output that means "send nothing". A sentinel, not the empty string —
 *  instructing a model to output literally nothing is far less reliable. */
const SILENCE = 'NO_UPDATE';

/** Compose one short progress update, or '' for silence (the default). */
export async function runTranslatorPass(opts: TranslatorOptions): Promise<string> {
  const sections = [
    `Sunny's working notes since the last update:\n${opts.interim}`,
    opts.recentUpdates.length > 0
      ? `Updates already sent to ${opts.subject} this turn (do not repeat their news):\n` +
        opts.recentUpdates.map((u) => `- ${u}`).join('\n')
      : `No update has been sent yet this turn.`,
    `Write the one short progress update Sunny should text ${opts.subject} now, or ${SILENCE}.`,
  ];
  const result = await generateText({
    model: opts.model,
    instructions: translatorSystem(opts.subject),
    messages: [{ role: 'user', content: sections.join('\n\n') }],
    // Traced like the recovery pass (observability D-OB1): how often updates fire —
    // and how often the translator declines — is itself a rollout signal.
    runtimeContext: {
      translator: true,
      trigger: 'progress-update',
      langfuseSessionId: opts.threadId,
    },
    telemetry: {
      isEnabled: telemetryEnabled(),
      functionId: 'progress-translator',
      includeRuntimeContext: { translator: true, trigger: true, langfuseSessionId: true },
    },
  });
  const text = result.text.trim();
  if (!text || text === SILENCE || text.startsWith(SILENCE)) return '';
  return text;
}

function translatorSystem(subject: string): string {
  return [
    `You relay progress updates for ${subject}'s iMessage assistant, Sunny. Sunny is mid-task`,
    `and still working; you are shown its working notes — anything it jotted down plus a`,
    `[ran <tool>: …] line for each tool it used — and decide whether ${subject} should get a`,
    `quick progress text right now.`,
    `- You are NOT Sunny and you are NOT doing the task — you only relay what the notes`,
    `  already say, in Sunny's voice: warm, concise, plain text, no markdown. One short`,
    `  message (a sentence or two) at most. An update grounded only in tool lines says what`,
    `  Sunny is DOING ("on it — digging through headphone reviews now"), never a result.`,
    `- SUMMARIZE ONLY. Never add facts, guesses, or results the notes don't contain.`,
    `- Never imply the task is finished — Sunny is still working, and its real reply arrives`,
    `  when it's done. No "all set", no final answers, no promises about timing.`,
    `- Silence is your DEFAULT. Output exactly ${SILENCE} when there's no user-relevant news:`,
    `  internal bookkeeping, a step still in progress with nothing to show, or nothing beyond`,
    `  what the already-sent updates said. Send an update only when ${subject} would genuinely`,
    `  want the heads-up.`,
    `- Quick work needs no update: if the notes show only a couple of fast tool calls (saving a`,
    `  note, setting a reminder, one lookup), Sunny will reply directly in a moment — output`,
    `  ${SILENCE}. Updates are for genuinely long tasks (research, building something,`,
    `  many steps).`,
    `- Output ONLY the update text (or ${SILENCE}) — no preamble, no quotes, nothing else.`,
  ].join('\n');
}
