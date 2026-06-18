import { deliveredViaSendMessage, isSilent, noFallback, sentSomething } from '../graders.js';
import type { EvalCase } from '../types.js';

/**
 * `send_message` elicitation (tasks 8.1, 8.2). The model must communicate ONLY
 * via `send_message` — never leaking private scratch as the user-facing reply —
 * and must stay silent when there is genuinely nothing worth saying.
 */
export const elicitationCases: EvalCase[] = [
  {
    // 8.1 simple reply: a plain question gets a delivered answer.
    name: 'elicitation/simple-reply',
    dimension: 'elicitation',
    input: 'what is the capital of France?',
    graders: [deliveredViaSendMessage, noFallback, sentSomething],
  },
  {
    // 8.1 multi-bubble: an explicit ask for several messages.
    name: 'elicitation/multi-bubble',
    dimension: 'elicitation',
    input: 'give me three quick tips for better sleep, one short message each',
    graders: [deliveredViaSendMessage, noFallback],
  },
  {
    // 8.1 interview back-and-forth: two turns; the reply both answers and continues.
    name: 'elicitation/interview',
    dimension: 'elicitation',
    input: ['help me plan a weekend trip', 'somewhere warm, leaving Friday'],
    graders: [deliveredViaSendMessage, noFallback, sentSomething],
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
];
