import type { ModelCallStreamPart, ModelMessage } from '../src/agent/aiTypes.js';
import { tool } from '@ai-sdk/provider-utils';
import { WorkflowAgent } from '@ai-sdk/workflow';
import { buildTurnModel, type MockResponseDescriptor } from '../src/agent/turnModel.js';
import { getWritable } from 'workflow';
import {
  BASH_TOOL_SPECS,
  type BashToolInput,
  type FileReadToolInput,
} from '../src/agent/tools/bashSpecs.js';
import { AGENT_STEP_LIMIT } from '../src/agent/limits.js';
import { type OutputTarget, outputTargetOr } from '../src/agent/outputTarget.js';
import { emitStep } from './runShell.js';

/**
 * Tier-2 durable job — the background-job PROFILE of the shared run shell (durable-subagents
 * D-DS11/D-DS14). Runs a `WorkflowAgent` at the workflow level, so each LLM call AND each tool
 * call is a durable step — the job survives crashes/reboots and resumes from its last completed
 * step. On completion it reports to its configured `output_target` (D-DS1) via the shared
 * `emitStep` — the same outward primitive `send_message` uses; the old bespoke `deliver` is gone.
 * Promoted from a conversational turn via `start_job`.
 *
 * The job has the real host tools (`bash`, `file_read`) so a backgrounded task can actually DO
 * work — build files, run CLIs (devbox, curl), read a skill's SKILL.md and follow it. Without
 * tools it could only *narrate* imagined tool calls as text, which then got delivered as nonsense
 * (the failure this fixes). Tool `execute`s are step-wrapped, mirroring `scheduledJob.ts`. No
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

  const agent = new WorkflowAgent({
    model: buildTurnModel(setup.modelId, setup.testModelResponses),
    instructions: setup.instructions,
    tools: {
      bash: tool({ ...BASH_TOOL_SPECS.bash, execute: (args) => bashStep(args) }),
      file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (args) => fileReadStep(args) }),
    },
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
  });

  // WorkflowAgent writes raw model-call parts to the durable run stream; the dashboard reader
  // converts them to UIMessageChunk via `createModelCallToUIChunkTransform()` (design 3.1 —
  // the transform can't run in the workflow sandbox, so it lives at the reader boundary).
  const result = await agent.stream({
    messages: [{ role: 'user', content: input.task }],
    writable: getWritable<ModelCallStreamPart>(),
    // No work cap — runaway backstop only (the old 30-step cap could cut off a build).
    stopWhen: ({ steps }) => steps.length >= AGENT_STEP_LIMIT,
    // Durable AI-SDK telemetry INTENTIONALLY OFF — the WDK runs the agent loop in an isolated
    // `node:vm` realm the global telemetry integration can't reach, so it would emit nothing
    // while looking enabled. See workflows/conversation.ts for the full rationale (vercel/ai #12164).
    telemetry: { isEnabled: false },
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

/** Run a shell command on the host as a durable step (mirrors the interactive bash tool). */
async function bashStep(args: BashToolInput): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execBash } = await import('../src/agent/tools/bash.js');
  const { resolverFromEnv } = await import('../src/credentials/index.js');
  const { config } = await getRuntime();
  return execBash(config, resolverFromEnv() ?? undefined, {
    command: args.command,
    cwd: args.cwd,
    timeout_ms: args.timeout_ms,
    credentials: args.credentials
      ? Object.fromEntries(Object.entries(args.credentials).map(([k, v]) => [k, String(v)]))
      : undefined,
  });
}

/** Read a host file as a durable step. */
async function fileReadStep(args: FileReadToolInput): Promise<string> {
  'use step';

  const { readFileSafe } = await import('../src/agent/tools/bash.js');
  return readFileSafe(args.path, args.max_bytes);
}

/** Final assistant text from the run's messages (the delivery payload). */
function finalAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    if (typeof m.content === 'string') return m.content.trim();
    return m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
      .trim();
  }
  return '';
}
