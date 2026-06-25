import { readFileSync } from 'node:fs';
import { deliveredViaSendMessage, elicitedWithoutRecovery, noFallback } from '../graders.js';
import type { EvalCase, FixtureTurn } from '../types.js';

/**
 * Elicitation cases built from REAL captured conversations (AGENTS.md: "Reproduce
 * loop/prompt/model bugs from REAL conversations"). Unlike the synthetic
 * `elicitationCases` — which pass even while production misses ~50% — these seed
 * the verbatim production history (`setup.fixtureTurns`, captured by
 * `evals/capture-turn.ts`), so the loop faces the exact context (token scale, tool
 * trajectory, send/scratch ratio) that drives the real miss.
 *
 * Graded with `elicitedWithoutRecovery`: a PASS means the model called `send_message`
 * itself; a FAIL means it left the reply in scratch and the backstop had to rescue it
 * (or ghosted). Run at high `-n` to get a stable elicitation rate to move.
 */
interface Fixture {
  input: string;
  turns: FixtureTurn[];
  memoryCore?: { user?: string; sunny?: string; index?: string };
}

function loadFixture(file: string): Fixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/elicitation/${file}.json`, import.meta.url), 'utf8'),
  );
}

function realCase(name: string, file: string): EvalCase {
  const fx = loadFixture(file);
  return {
    name: `elicitation/${name}`,
    dimension: 'elicitation',
    setup: { fixtureTurns: fx.turns, memoryCore: fx.memoryCore },
    input: fx.input,
    graders: [deliveredViaSendMessage, noFallback, elicitedWithoutRecovery],
  };
}

export const realElicitationCases: EvalCase[] = [
  // Conversational turns late in a long, tool-laden thread — the model should just reply,
  // but in production it frequently writes the reply as scratch instead (elicitation miss).
  realCase('real-inbox-clarify', 'real-inbox-clarify'),
  realCase('real-batches', 'real-batches'),
];
