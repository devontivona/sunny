import {
  deliveredReply,
  elicitedWithoutRecovery,
  noFallback,
  scratchNotSecondPerson,
} from '../graders.js';
import { replyComplete, scratchIsWorkingNotes, translatorFidelity } from '../judge.js';
import { REAL_MISSES, type RealMiss } from './fixtures/realMisses.js';
import type { ConversationSeed, EvalCase } from '../types.js';

/**
 * Chained cases built from the 16 captured production misses (fixtures/realMisses.ts,
 * auto-captured 2026-06-23). Each case replays a short conversation arc that ended in
 * a real elicitation miss, then grades the final turn live.
 *
 * Every chain comes in two variants (seed-audit policy, 2026-07):
 *
 * - `clean` — prior assistant turns are seeded as delivered sends (what the user
 *   actually received once recovery fired). Measures elicitation against well-formed
 *   history. `history: 'seeded-clean'`.
 * - `poisoned` — prior assistant turns are seeded EXACTLY as production persisted
 *   them: the reply sitting in private scratch, zero sends. This reproduces the
 *   in-context precedent ("past-me replied in plain text") that pressures the next
 *   turn toward the same miss. Measures robustness; reported separately so it never
 *   blurs clean-history rates. `history: 'seeded-poisoned'`.
 *
 * The misses' user text is kept verbatim, typos included — that's what production saw.
 */
const byName = new Map(REAL_MISSES.map((m) => [m.name, m]));
function miss(name: string): RealMiss {
  const m = byName.get(name);
  if (!m) throw new Error(`unknown real miss: ${name}`);
  return m;
}

function priorExchanges(misses: RealMiss[], poisoned: boolean): ConversationSeed[] {
  return misses.flatMap((m): ConversationSeed[] => [
    { role: 'user', text: m.user },
    poisoned
      ? // As production persisted it: the reply left in scratch, nothing sent.
        { role: 'assistant', text: '', scratch: m.scratch, sends: [] }
      : // As the user experienced it post-recovery: the reply delivered.
        { role: 'assistant', text: m.scratch },
  ]);
}

function chainCase(opts: {
  name: string;
  prior: string[];
  input: string;
  poisoned: boolean;
}): EvalCase {
  return {
    name: `elicitation/${opts.name}-${opts.poisoned ? 'poisoned' : 'clean'}`,
    dimension: 'elicitation',
    history: opts.poisoned ? 'seeded-poisoned' : 'seeded-clean',
    setup: { conversation: priorExchanges(opts.prior.map(miss), opts.poisoned) },
    input: opts.input,
    graders: [
      deliveredReply,
      noFallback,
      elicitedWithoutRecovery,
      scratchIsWorkingNotes,
      scratchNotSecondPerson,
      replyComplete,
      translatorFidelity,
    ],
  };
}

/** Arc definitions — one entry expands to a clean + a poisoned case. */
const CHAINS: Array<{ name: string; prior: string[]; input: string }> = [
  {
    // Smalltalk history, then a substantive ask. Short social turns were the single
    // most common miss shape (misses 1/3/4/9/14: the model "spoke" only in scratch).
    name: 'miss-chain-smalltalk',
    prior: ['real-miss-9', 'real-miss-4'],
    input: miss('real-miss-10').user, // "Can you help me think of a birthday present for Shannon>"
  },
  {
    // The get-to-know-you interview arc (misses 5-8): reflective, memory-adjacent
    // turns where the model drifts into monologue.
    name: 'miss-chain-interview',
    prior: ['real-miss-5', 'real-miss-6'],
    input: miss('real-miss-8').user, // "…what do you think is missing from your soul doc…"
  },
  {
    // The meta-question about this exact mechanism (miss 2) — production missed the
    // turn where the user asked whether send_message was being used correctly.
    name: 'miss-chain-meta',
    prior: ['real-miss-1'],
    input: miss('real-miss-2').user,
  },
];

export const elicitationMissCases: EvalCase[] = CHAINS.flatMap((c) => [
  chainCase({ ...c, poisoned: false }),
  chainCase({ ...c, poisoned: true }),
]);
