import OpenAI from 'openai';
import { LLMClassifierFromTemplate } from 'autoevals';
import type { Grader, GradeResult, Trajectory } from './types.js';

/**
 * LLM-as-judge graders (task 7.4 / agent-evals spec).
 *
 * Reserved for genuinely fuzzy qualities (tone, helpfulness, natural memory use)
 * that programmatic graders can't check. Built on `autoevals` and judged by
 * **Sonnet 5** — the same tier as the model under test, so grading isn't done by a
 * weaker model than the one it's scoring (design D7/D14). The judge model + rubric
 * version are recorded with every result.
 *
 * autoevals talks to an OpenAI-compatible client; we point one at Anthropic's
 * OpenAI-compatible endpoint with the `ANTHROPIC_API_KEY`, so the judge runs on
 * Claude with no extra provider.
 */
export const JUDGE_MODEL = 'claude-sonnet-5';
export const RUBRIC_VERSION = 'v1';

let cachedClient: OpenAI | undefined;
function judgeClient(): OpenAI {
  if (!cachedClient) {
    cachedClient = new OpenAI({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: 'https://api.anthropic.com/v1/',
    });
  }
  return cachedClient;
}

/**
 * Build a binary (yes/no) rubric judge. `passThreshold` (default 0.5) maps the
 * judge's 0..1 score to pass/fail. The rationale + judge model/rubric are recorded.
 */
export function rubricJudge(opts: {
  name: string;
  /** The yes/no question, e.g. "Does the reply use the recalled fact naturally?" */
  question: string;
  passThreshold?: number;
  /** What trajectory field the judge grades (default: the user-facing reply). */
  outputOf?: (t: Trajectory) => string;
  /** Label introducing the graded text in the prompt (default 'User-facing reply:'). */
  outputLabel?: string;
  /** Advisory verdicts are tracked per-grader but never flip the case pass/fail. */
  advisory?: boolean;
}): Grader {
  const classifier = LLMClassifierFromTemplate<{ trajectory: Trajectory }>({
    name: opts.name,
    promptTemplate: [
      'You are grading an iMessage assistant ("Sunny").',
      '',
      `${opts.outputLabel ?? 'User-facing reply:'}\n{{output}}`,
      '',
      `Question: ${opts.question}`,
      'Answer Y if it clearly holds, otherwise N.',
    ].join('\n'),
    choiceScores: { Y: 1, N: 0 },
    useCoT: true,
  });

  return async (t): Promise<GradeResult> => {
    const score = await classifier({
      output: (opts.outputOf ?? ((tr) => tr.finalText))(t),
      // autoevals bundles its own `openai` types; cast across the dual-package
      // identity to the client type this classifier expects.
      client: judgeClient() as unknown as Parameters<typeof classifier>[0]['client'],
      model: JUDGE_MODEL,
      trajectory: t,
    });
    const value = score.score ?? 0;
    const threshold = opts.passThreshold ?? 0.5;
    return {
      name: `${opts.name} (judge:${JUDGE_MODEL}/${RUBRIC_VERSION})`,
      pass: value >= threshold,
      score: value,
      rationale:
        typeof score.metadata?.rationale === 'string' ? score.metadata.rationale : undefined,
      ...(opts.advisory ? { advisory: true } : {}),
    };
  };
}

/**
 * Scratch-quality judge (advisory): is the turn's PRIVATE text genuinely working
 * notes, or a reply addressed at the user that should have been a `send_message`?
 * Vacuous pass on empty scratch — with extended thinking on, no scratch at all is
 * the ideal outcome, not a gap. Advisory: it measures the dual-channel failure
 * (user-directed language leaking into text) without flipping delivery-mechanics
 * cases whose scratch is merely imperfect.
 */
const scratchJudge = rubricJudge({
  name: 'scratch-is-working-notes',
  question:
    'Is this private text working notes / telemetry (facts jotted for later, options weighed, ' +
    'progress markers)? Answer N if any part of it reads as a message TO the user — direct ' +
    'address ("you/your"), greetings, questions posed to them, or a composed reply.',
  outputOf: (t) => t.scratch,
  outputLabel: "The assistant's PRIVATE scratch text for this turn (never delivered):",
  advisory: true,
});

export const scratchIsWorkingNotes: Grader = (t, c) => {
  if (!t.scratch) {
    return { name: 'scratch-is-working-notes', pass: true, score: 1, advisory: true };
  }
  return scratchJudge(t, c);
};
