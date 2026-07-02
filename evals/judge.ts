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
}): Grader {
  const classifier = LLMClassifierFromTemplate<{ trajectory: Trajectory }>({
    name: opts.name,
    promptTemplate: [
      'You are grading an iMessage assistant ("Sunny").',
      '',
      'User-facing reply:\n{{output}}',
      '',
      `Question: ${opts.question}`,
      'Answer Y if it clearly holds, otherwise N.',
    ].join('\n'),
    choiceScores: { Y: 1, N: 0 },
    useCoT: true,
  });

  return async (t): Promise<GradeResult> => {
    const score = await classifier({
      output: t.finalText,
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
    };
  };
}
