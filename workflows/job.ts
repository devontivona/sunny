import { tool } from '@ai-sdk/provider-utils';
import { buildTurnModel, type MockResponseDescriptor } from '../src/agent/turnModel.js';
import { BASH_TOOL_SPECS } from '../src/agent/tools/bashSpecs.js';
import { type OutputTarget, outputTargetOr } from '../src/agent/outputTarget.js';
import { bashStep, emitStep, fileReadStep, finalAssistantText, streamAgent } from './runShell.js';

/**
 * Tier-2 durable job — the background-job PROFILE of the shared run shell (durable-subagents
 * D-DS11/D-DS14). Runs the shared `streamAgent` loop, so each LLM call AND each tool call is a
 * durable step — the job survives crashes/reboots and resumes from its last completed step. On
 * completion it reports to its configured `output_target` (D-DS1) via the shared `emitStep` — the
 * same outward primitive `send_message` uses; the old bespoke `deliver` is gone. Promoted from a
 * conversational turn via `start_job`.
 *
 * The job has the real host tools (`bash`, `file_read`) so a backgrounded task can actually DO
 * work — build files, run CLIs (devbox, curl), read a skill's SKILL.md and follow it. No
 * `send_message`/`schedule`/`start_job` (no mid-run chatter, no nested jobs, no self-scheduling):
 * the agent's final text IS the deliverable, emitted terminally (`recoverOnMiss: 'rawtext'`).
 */
/** Default model for a background job; overridable per run (D-DS9, configurable model). */
const DEFAULT_JOB_MODEL = 'claude-opus-4-8';

export interface JobInput {
  threadId: string;
  task: string;
  ownerName: string;
  /** Where the result is reported (D-DS1); defaults to `user` (the owner via the gateway). */
  outputTarget?: OutputTarget;
  /** Model id for this run (D-DS9); defaults to the standard job model. */
  model?: string;
}

export async function runJob(input: JobInput): Promise<void> {
  'use workflow';

  const setup = await buildSetup(input.model ?? DEFAULT_JOB_MODEL);

  const { result } = await streamAgent({
    model: buildTurnModel(setup.modelId, setup.testModelResponses),
    instructions: setup.instructions,
    tools: {
      bash: tool({ ...BASH_TOOL_SPECS.bash, execute: (args) => bashStep(args) }),
      file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (args) => fileReadStep(args) }),
    },
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
    messages: [{ role: 'user', content: input.task }],
  });

  // `recoverOnMiss: 'rawtext'` — the final assistant text is the deliverable. `emitStep` routes
  // by output target and is a no-op when `silent` or empty (the empty fallback below only ever
  // reaches a `user` target). One emit path; no separate deliver.
  const text = finalAssistantText(result.messages);
  const message = text || 'I finished that background task but came up empty — mind rephrasing?';
  await emitStep(
    { target: outputTargetOr(input.outputTarget), destThreadId: input.threadId },
    message,
  );
}

interface JobSetup {
  instructions: string;
  modelId: string;
  /** Mock model responses set by a workflow test (read in the step where the global is visible);
   *  undefined in production, so `buildTurnModel` returns the real Anthropic provider. */
  testModelResponses?: MockResponseDescriptor[];
}

/**
 * Build the background-run instructions + model config once, in a step, so they stay stable
 * across replays. Uses the shared job-prompt builder — same identity, memory core, and SKILLS
 * index as the interactive thread (so the job is skill-aware, e.g. knows website-builder exists),
 * with the host-tools section and the job delivery model. Reads the test-model seam here (in the
 * step, where a test's `globalThis` override is visible) and threads it to the body — the same
 * pattern `conversation.ts`'s `setupTurn` uses, so a job is mockable in the workflow suite.
 */
async function buildSetup(modelId: string): Promise<JobSetup> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { loadCore, memoryPaths } = await import('../src/memory/index.js');
  const { loadAllSkills, renderSkillIndex } = await import('../src/skills/index.js');
  const { buildJobPrompt } = await import('../src/agent/prompt.js');
  const { testModelResponses } = await import('../src/agent/turnModel.js');
  const { config } = await getRuntime();
  const core = loadCore(memoryPaths(config.runtimeDir));
  const skillsIndex = renderSkillIndex(loadAllSkills(config), config.skills);
  return {
    instructions: buildJobPrompt(config, core, skillsIndex, { hostTools: true }),
    modelId,
    testModelResponses: testModelResponses(),
  };
}
