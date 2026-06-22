import type { MemoryWriteInput } from '../../src/memory/index.js';
import type { ConversationSeed } from '../types.js';

/**
 * Advanced scenarios for the thinking on/off A/B (not pass/fail eval cases).
 *
 * Chosen to STRESS elicitation where it historically slipped: multi-turn
 * back-and-forth ("chat mode" drift), ambiguous speak-vs-silence, and complex
 * multi-part requests. Each scenario is a sequence of user turns played on one
 * thread; we measure per-turn behavior (did the primary model call send_message /
 * stay_silent without a recovery nudge), scratch, tokens, and latency.
 */
export type Tier = 'multiturn' | 'ambiguous' | 'complex';

export interface Scenario {
  name: string;
  tier: Tier;
  setup?: { memory?: MemoryWriteInput[]; conversation?: ConversationSeed[] };
  /** Sequential user messages, each its own turn. */
  turns: string[];
  /** Turn indices where staying silent is the right call (acks: 👍, "thanks", "ok"). */
  ackTurns?: number[];
}

export const SCENARIOS: Scenario[] = [
  // --- multi-turn back-and-forth (the historical miss hotspot) ---
  {
    name: 'trip-planning',
    tier: 'multiturn',
    turns: [
      'help me plan a weekend trip',
      'somewhere warm',
      "i'm in boston, flying is fine",
      'mid-february, 3 days, not too expensive',
    ],
  },
  {
    name: 'debug-help',
    tier: 'multiturn',
    turns: [
      'my node app crashes on startup',
      "it says 'cannot find module express'",
      'yeah i just cloned it fresh',
      'that fixed it, thanks',
    ],
    ackTurns: [3],
  },
  {
    name: 'name-the-puppy',
    tier: 'multiturn',
    turns: [
      'help me name my new puppy',
      "she's a golden retriever, super playful",
      'i like the second one you said',
      'perfect',
    ],
    ackTurns: [3],
  },
  {
    name: 'spanish-quiz',
    tier: 'multiturn',
    turns: ['quiz me on spanish vocab, 3 words', 'casa', 'perro', 'no idea on the last one'],
  },
  {
    name: 'weather-terse',
    tier: 'multiturn',
    turns: ['weather', 'tomorrow?', 'thanks'],
    ackTurns: [2],
  },

  // --- ambiguous speak-vs-silence (over/under-sending shows here) ---
  {
    name: 'acks-after-reminder',
    tier: 'ambiguous',
    setup: {
      conversation: [
        { role: 'user', text: 'remind me to call mom at 6' },
        { role: 'assistant', text: "Done — I'll remind you at 6pm." },
      ],
    },
    turns: ['👍', 'thanks', 'ok'],
    ackTurns: [0, 1, 2],
  },
  {
    name: 'ack-then-correction',
    tier: 'ambiguous',
    setup: {
      conversation: [
        { role: 'user', text: 'set a timer for the pasta, 10 min' },
        { role: 'assistant', text: 'Timer set for 10 minutes.' },
      ],
    },
    turns: ['got it', 'actually make it 12'],
    ackTurns: [0],
  },
  {
    name: 'low-key-venting',
    tier: 'ambiguous',
    turns: ['rough day today', 'just work stuff, nothing major', 'thanks for listening'],
    ackTurns: [2],
  },

  // --- complex single / multi-part requests ---
  {
    name: 'multi-part-request',
    tier: 'complex',
    turns: [
      'research the best budget standing desks under $300, and also remind me to follow up with the dentist tomorrow at 10am',
    ],
  },
  {
    name: 'nuanced-decision',
    tier: 'complex',
    turns: [
      'should i take the new job? it pays 20% more but longer commute and i like my current team',
      'the commute would be about 50 min each way',
    ],
  },
  {
    name: 'memory-laden-dinner',
    tier: 'complex',
    setup: {
      memory: [
        { file: 'USER', action: 'add', content: '- Allergic to shellfish' },
        { file: 'USER', action: 'add', content: '- Has a dog named Rex' },
      ],
    },
    turns: ['planning dinner for friends saturday, ideas?', 'one of them is vegetarian'],
  },
  {
    name: 'open-ended-advice',
    tier: 'complex',
    turns: [
      "i want to get back into running but i always burn out after a week, what's a sustainable way to start?",
    ],
  },
];
