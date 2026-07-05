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
  /** The step the turn is on (1-based-ish; grows with tool use). */
  stepNumber: number;
  /** Steps since the last SENT update — or since the turn began if none was sent. */
  stepsSinceUpdate: number;
  /** The turn's thread id, so the span groups with that turn's Langfuse session. */
  threadId: string;
}

/** The output that means "send nothing" — the same sentinel format as `<no-reply/>` /
 *  `<no-report/>`. A sentinel, not the empty string: instructing a model to output
 *  literally nothing is far less reliable. */
const SILENCE = '<no-update/>';

/** Fuzzy decline detection: `<no-update/>`, `<no-update>`, `no_update`, the legacy bare
 *  `NO_UPDATE`, any casing/spacing. Deliberately the OPPOSITE semantics of stripNoReply:
 *  a final reply is never swallowed (content survives a stray sentinel), but an interim
 *  update is DISPOSABLE — if any part of the output signals "no update", the model meant
 *  to decline, so the whole output is dropped (2026-07-05: Haiku emitted update text PLUS
 *  the sentinel, and the sentinel-prefix check let the combined blob reach the user). */
const NO_UPDATE_FUZZY = /<\s*no[-_\s]?update\s*\/?\s*>|\bNO_UPDATE\b/i;

/** Parse the translator's raw output into "the update to send" ('' = silence). Exported
 *  for unit tests. */
export function parseTranslatorUpdate(raw: string): string {
  const text = raw.trim();
  if (!text || NO_UPDATE_FUZZY.test(text)) return '';
  return text;
}

/** Compose one short progress update, or '' for silence (the default). */
export async function runTranslatorPass(opts: TranslatorOptions): Promise<string> {
  const sections = [
    // The "longness" signal (2026-07-05 investigation: without it, every beat of a long
    // turn looked like quick work and the translator declined 9/9 on a 15-step task).
    `Sunny is on step ${opts.stepNumber} of this task. ` +
      (opts.recentUpdates.length > 0
        ? `The last update went out ${opts.stepsSinceUpdate} steps ago.`
        : `${opts.subject} has heard NOTHING yet this turn (${opts.stepsSinceUpdate} steps and counting).`),
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
  return parseTranslatorUpdate(result.text);
}

function translatorSystem(subject: string): string {
  return [
    `You ARE Sunny, ${subject}'s iMessage assistant, mid-task with your hands full — these are`,
    `YOUR working notes (things you jotted down, plus a [ran <tool>: …] line per tool you used).`,
    `Decide whether ${subject} should get a quick progress text from you right now.`,
    `- Speak in FIRST PERSON, as yourself: "Found it — sorting out a login snag, one sec."`,
    `  NEVER refer to Sunny in the third person, and NEVER describe the notes from outside`,
    `  ("Looking at the notes…", "Sunny is running…") — ${subject} is texting WITH you and`,
    `  has no idea notes exist. Just say the thing.`,
    `- Your ONLY job here is the quick text — you cannot do more work in this message, only`,
    `  report where things stand. Warm, concise, plain text, no markdown. One short message`,
    `  (a sentence or two) at most. Grounded only in tool lines? Say what you're DOING,`,
    `  never a result.`,
    `- BUILD the update from your notes' own phrasing — they're already varied and in your`,
    `  voice; compress rather than invent. Standard sentence capitalization and punctuation.`,
    `  Never all-lowercase.`,
    `- SUMMARIZE ONLY. Never add facts, guesses, or results the notes don't contain.`,
    `- Never imply the task is finished — Sunny is still working, and its real reply arrives`,
    `  when it's done. No "all set", no final answers, no promises about timing.`,
    `- THE FIRST UPDATE of a turn is special: if nothing has been sent yet and the notes show`,
    `  real multi-step work underway (research, building, several tool calls ahead), ALWAYS send`,
    `  a brief opener naming the work. Build it by compressing Sunny's own first note — its`,
    `  acknowledgment is already varied and in-voice. Don't develop a signature opener: if your`,
    `  update would start the way most turns' updates start, take the phrasing from a different`,
    `  part of Sunny's note instead (usually the part that names the work). ${subject} should`,
    `  never sit through a long task in total silence — output ${SILENCE} on the first beat`,
    `  only when the notes show the task is already wrapping up (a quick lookup or a saved`,
    `  note — Sunny's own reply will arrive before an update would help).`,
    `- AFTER the opener, silence is your DEFAULT. Output exactly ${SILENCE} when there's no`,
    `  user-relevant news since the last update: internal bookkeeping, retries, or nothing`,
    `  beyond what the already-sent updates said.`,
    `- One voice across the turn: never re-acknowledge after the opener — no second "on it",`,
    `  no "working on it", no re-introducing the task. ${subject} already heard that. Every`,
    `  later update leads with what is NEW since the last one.`,
    `- Your ENTIRE output is one of exactly two things: the update text, or ${SILENCE} alone.`,
    `  NEVER combine them — an output that contains ${SILENCE} anywhere is treated as`,
    `  declining, and none of it is sent. No preamble, no quotes, no explanation.`,
  ].join('\n');
}
