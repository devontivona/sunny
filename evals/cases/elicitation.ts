import {
  deliveredViaSendMessage,
  elicitedWithoutRecovery,
  finalTurnSilent,
  isSilent,
  noFallback,
  sentSomething,
} from '../graders.js';
import type { EvalCase } from '../types.js';

/**
 * `send_message` elicitation (tasks 8.1, 8.2). The model must communicate ONLY
 * via `send_message` — never leaking private scratch as the user-facing reply —
 * and must stay silent when there is genuinely nothing worth saying.
 *
 * Every substantive case also asserts `elicitedWithoutRecovery`: the reply was
 * delivered AND the backstop did not have to rescue it. The old masking backstop
 * could turn a primary miss into a green `delivered=send_message`; grading the
 * pre-recovery fact stops that from hiding an elicitation regression.
 *
 * Multi-turn cases pass the whole exchange as `input: string[]` — the model plays
 * each turn live — and grade the FINAL turn (the harness builds the trajectory
 * from the last assistant turn). The back-and-forth is what stresses elicitation;
 * the historical misses clustered in multi-step / mid-conversation turns.
 */
export const elicitationCases: EvalCase[] = [
  {
    // 8.1 simple reply: a plain question gets a delivered answer.
    name: 'elicitation/simple-reply',
    dimension: 'elicitation',
    input: 'what is the capital of France?',
    graders: [deliveredViaSendMessage, noFallback, sentSomething, elicitedWithoutRecovery],
  },
  {
    // 8.1 multi-bubble: an explicit ask for several messages.
    name: 'elicitation/multi-bubble',
    dimension: 'elicitation',
    input: 'give me three quick tips for better sleep, one short message each',
    graders: [deliveredViaSendMessage, noFallback, elicitedWithoutRecovery],
  },
  {
    // 8.1 interview back-and-forth: two turns; the reply both answers and continues.
    name: 'elicitation/interview',
    dimension: 'elicitation',
    input: ['help me plan a weekend trip', 'somewhere warm, leaving Friday'],
    graders: [deliveredViaSendMessage, noFallback, sentSomething, elicitedWithoutRecovery],
  },
  {
    // 8.2 silence: an acknowledgment after a completed task needs no reply.
    name: 'elicitation/silence-when-nothing-to-say',
    dimension: 'elicitation',
    setup: {
      conversation: [
        { role: 'user', text: 'remind me to call mom at 6' },
        { role: 'assistant', text: "Done — I'll remind you at 6pm." },
      ],
    },
    input: '👍',
    graders: [isSilent],
  },

  // --- Promoted from the delivery A/B scenarios (evals/experiments/scenarios.ts) ---

  {
    // Restraint on a worded ack after a completed task — must stay silent.
    name: 'elicitation/ack-thanks-after-task',
    dimension: 'elicitation',
    setup: {
      conversation: [
        { role: 'user', text: 'set a timer for the pasta, 10 min' },
        { role: 'assistant', text: 'Timer set for 10 minutes.' },
      ],
    },
    input: 'thanks',
    graders: [isSilent],
  },
  {
    // Speak-vs-silence boundary: an ack, then a real correction. The graded final
    // turn must elicit (not get stuck in the "it's just an ack" groove).
    name: 'elicitation/ack-then-correction',
    dimension: 'elicitation',
    setup: {
      conversation: [
        { role: 'user', text: 'set a timer for the pasta, 10 min' },
        { role: 'assistant', text: 'Timer set for 10 minutes.' },
      ],
    },
    input: ['got it', 'actually make it 12'],
    graders: [deliveredViaSendMessage, noFallback, elicitedWithoutRecovery],
  },
  {
    // Multi-turn back-and-forth (the historical miss hotspot): four live turns;
    // the substantive final turn must still elicit after the exchange.
    name: 'elicitation/multiturn-trip',
    dimension: 'elicitation',
    input: [
      'help me plan a weekend trip',
      'somewhere warm',
      "i'm in boston, flying is fine",
      'mid-february, 3 days, not too expensive',
    ],
    graders: [deliveredViaSendMessage, noFallback, elicitedWithoutRecovery],
  },
  {
    // Multi-turn restraint: a debug exchange that ends on "that fixed it, thanks"
    // — the graded final turn closes the loop and should be silent.
    name: 'elicitation/multiturn-debug-then-ack',
    dimension: 'elicitation',
    input: [
      'my node app crashes on startup',
      "it says 'cannot find module express'",
      'yeah i just cloned it fresh',
      'that fixed it, thanks',
    ],
    // Multi-turn: earlier turns legitimately speak, so grade the FINAL turn's
    // outcome via `delivered`, not cumulative outbound (see finalTurnSilent).
    graders: [finalTurnSilent],
  },
];
