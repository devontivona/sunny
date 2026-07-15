import {
  extractReportBlocks,
  NO_REPLY_SENTINEL,
  NO_REPORT_SENTINEL,
  stripSentinel,
} from './delivery.js';

/**
 * The voice layer (unified-voice-layer D-VL3): ONE derived speech contract for every run
 * profile, in two halves — the prompt block that tells a run who reads its final text and how
 * to be silent, and the terminal parser that turns a final text into deliverable speech. The
 * three prompt builders embed `voiceBlock`; the three workflow finalizers call
 * `finalizeSpeech`. Hand-written per-profile speech contracts are the drift that produced the
 * 2026-07-13 pathologies — nothing outside this module states these rules.
 *
 * Lanes (D-VL4): a conversational turn is a SPEAKER — its final text is gateway-delivered to
 * a human, and its silence token is `<no-reply/>`. Every autonomous run (subagent, scheduled)
 * is a REPORTER — its final text is a report mediated by a conversational turn, and its
 * silence token is `<no-report/>`. One semantics for both: the token's PRESENCE anywhere in
 * the final text silences the whole reply (see `stripSentinel`).
 *
 * Node-free (imports only `delivery.ts`) so durable workflow files can import it at module
 * scope, exactly like the tool specs.
 */
export type VoiceLane = 'speaker' | 'reporter';

export interface SpeakerVoice {
  lane: 'speaker';
  /** The human this turn speaks to — the audience's subject (owner or family member). */
  subject: string;
}

export interface ReporterVoice {
  lane: 'reporter';
  /** Short prose naming who reads the report — e.g. "your orchestrator" for a subagent,
   *  or "the conversation that speaks for Devon" for a scheduled run. */
  recipient: string;
}

export type VoiceSpec = SpeakerVoice | ReporterVoice;

/** The lane's silence token (D-VL4). */
export function laneSentinel(lane: VoiceLane): string {
  return lane === 'speaker' ? NO_REPLY_SENTINEL : NO_REPORT_SENTINEL;
}

/**
 * The generated speech-contract prompt lines for a run's lane. Rules only, never example
 * messages (prompt-examples-become-output, July 2026). The ack framing inside the speaker
 * silence bullet is kept VERBATIM from the PR #30 composer arm (it held silence 5/6 there —
 * don't reword it).
 */
export function voiceBlock(spec: VoiceSpec): string[] {
  return spec.lane === 'speaker' ? speakerBlock(spec.subject) : reporterBlock(spec.recipient);
}

function speakerBlock(subject: string): string[] {
  return [
    `How you speak — read carefully:`,
    `- Your reply IS the message: the text you end your turn with is delivered to ${subject} as`,
    `  one iMessage, exactly as written. Write it the way a person texting back would —`,
    `  concise, warm, plain text, no markdown.`,
    `- While you're working with tools, brief working notes as you go are fine — they're the`,
    `  source material for short progress updates relayed to ${subject} during long tasks; the`,
    `  notes themselves aren't delivered. Jot what you're doing and what you found as you go.`,
    `- Never narrate delivery mechanics into the reply itself (no "sending this now", no notes`,
    `  about which path a message takes) — the reply is only what ${subject} should read.`,
    `- Silence is valid: when ${subject}'s message just closes the loop — a 👍 or reaction, "ok",`,
    `  "thanks", "got it", "sounds good" — and you have nothing genuinely useful to add, reply`,
    `  with exactly <no-reply/> and nothing else. A reply containing that token is not sent —`,
    `  ${subject} receives no message — and it is the ONLY way to say nothing. Don't acknowledge`,
    `  every acknowledgment — that's noise. But the instant there IS something worth saying,`,
    `  just say it.`,
    `- Messages labeled "<name> (subagent):" or "<name> (scheduled):" are reports from your own`,
    `  workers — ${subject} has NOT seen them. Your reply still goes to ${subject}, never to a`,
    `  worker: relay what the report means for ${subject}, in your own voice, folded into the`,
    `  live conversation — don't re-announce what was just discussed, and don't interrupt an`,
    `  active exchange for a low-value update (<no-reply/> is fine; the report stays on record).`,
    `  A RUNNING subagent can be steered with the message tool (its id from delegate_task),`,
    `  though children continue without acknowledgments — most reports need none. A (scheduled)`,
    `  report's run has already finished and cannot be messaged: anything it asks is yours to`,
    `  answer for ${subject}, or to let go.`,
  ];
}

function reporterBlock(recipient: string): string[] {
  return [
    `How you report:`,
    `- Your FINAL text is your report — it is delivered verbatim, as one message, to`,
    `  ${recipient} when you finish. End your turn on the report itself.`,
    `- Your reader is another agent, not a person: report COMPACT, STRUCTURED facts — what`,
    `  happened, what matters, any suggested emphasis — not finished user-facing prose and not`,
    `  raw tool output. The conversation relays it in Sunny's own voice.`,
    `- If you produced files or images someone should see, put their paths in the report — the`,
    `  conversation sends media; you don't.`,
    `- Most tasks need no progress report. For a genuinely long task, or when you hit something`,
    `  ${recipient} should know NOW (a blocker, a surprise), write <report>…</report> on its`,
    `  own lines mid-task — its content is delivered immediately and you keep working. Everything`,
    `  outside these blocks and your final text is private working space.`,
    `- If there is genuinely nothing ${recipient} needs, make your reply exactly <no-report/> —`,
    `  a reply containing that token delivers nothing at all.`,
    `- Never narrate delivery mechanics into the report (no "sending this through", no notes`,
    `  about which path it takes) — the report is only the content itself.`,
  ];
}

/** A finalized terminal text: deliberate mid-task blocks, the deliverable final, and whether
 *  the lane's silence token appeared (presence = the whole final is silent). */
export interface Speech {
  reports: string[];
  final: string;
  sentinel: boolean;
}

/**
 * The one terminal parser (D-VL3b): report-block extraction (reporter lane only — a speaker's
 * reply has no block convention) + the lane's sentinel parse. Callers feed the run's extracted
 * final TEXT; classification (`classifyTextDelivery`) stays with the caller that needs it.
 */
export function finalizeSpeech(text: string, lane: VoiceLane): Speech {
  const { reports, rest } = lane === 'reporter' ? extractReportBlocks(text) : { reports: [], rest: text };
  let parsed = stripSentinel(rest, laneSentinel(lane));
  // Reporter tolerance (code-review 2026-07-15): live schedule prompts, skills, and recorded
  // precedent all taught <no-reply/> before the lane split, so a reporter emitting the speaker
  // token means silence — not a report containing the literal token. (A reporter QUOTING the
  // token inside a real report is the rare case, and the raw text stays recorded either way.)
  // Speakers stay strict: a reply to a human that mentions <no-report/> is real content.
  if (lane === 'reporter' && !parsed.sentinel) {
    parsed = stripSentinel(rest, NO_REPLY_SENTINEL);
  }
  return { reports, final: parsed.text, sentinel: parsed.sentinel };
}
