import { tool } from '@ai-sdk/provider-utils';
import { buildTurnModel, type MockResponseDescriptor } from '../src/agent/turnModel.js';
import { MEMORY_TOOL_SPECS } from '../src/agent/tools/memorySpecs.js';
import { type OutputTarget, outputTargetOr } from '../src/agent/outputTarget.js';
import { emitStep, finalAssistantText, streamAgent } from './runShell.js';

/**
 * Durable job for a fired schedule — the scheduled-job PROFILE of the shared run shell
 * (scheduling D-SC2/5; durable-subagents D-DS11/D-DS14). Runs an autonomous `WorkflowAgent`
 * (D-DE1/2): each LLM call and tool call is a durable workflow step, so a crash mid-run resumes
 * from the last completed step instead of re-running the whole agent.
 *
 * MEMORY tools only — no send_message, no schedule tools, no start_job — which enforces the
 * anti-recursion guard (D-SC4: a scheduled run cannot create schedules) and least privilege by
 * construction. Tool `execute` is step-wrapped so a replay never re-applies a non-idempotent
 * `memory_write` (add appends). The outcome is always recorded (`recordRun`); the reply is
 * reported to the schedule's `output_target` via the shared `emitStep` — so a maintenance
 * schedule set `silent` (nightly memory consolidation) records its result but sends NO 2am text.
 */
export interface ScheduledJobInput {
  scheduleId: string;
  runId: string;
  threadId: string;
  prompt: string;
  ownerName: string;
  /** Where the reply is reported (D-DS1); defaults to `user`. `silent` = record-only. */
  outputTarget?: OutputTarget;
  /** Model id for this run (D-DS9); defaults to the standard job model. */
  model?: string;
}

/** Default model for a scheduled run; overridable per run (D-DS9). */
const DEFAULT_SCHEDULED_MODEL = 'claude-opus-4-8';

export async function runScheduledJob(input: ScheduledJobInput): Promise<void> {
  'use workflow';

  const setup = await buildSetup(input.model ?? DEFAULT_SCHEDULED_MODEL);

  const { result } = await streamAgent({
    model: buildTurnModel(setup.modelId, setup.testModelResponses),
    instructions: setup.instructions,
    tools: {
      memory_write: tool({
        ...MEMORY_TOOL_SPECS.memory_write,
        execute: (args) => writeStep(args),
      }),
      read_topic: tool({
        ...MEMORY_TOOL_SPECS.read_topic,
        execute: ({ name }) => readTopicStep(name),
      }),
      recall_history: tool({
        ...MEMORY_TOOL_SPECS.recall_history,
        execute: ({ query, limit }) => recallStep(query, limit),
      }),
    },
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
    messages: [{ role: 'user', content: input.prompt }],
  });

  // Record-always ⟂ emit-by-target (D-DS14): the outcome is recorded regardless of output target
  // (so a `silent` run is still inspectable), then reported only when not silent. `recoverOnMiss:
  // 'rawtext'` — the agent's final text is the deliverable.
  const text = finalAssistantText(result.messages);
  await recordRun(input.runId, text);
  await emitStep(
    { target: outputTargetOr(input.outputTarget), destThreadId: input.threadId },
    text,
  );
}

interface ScheduledSetup {
  instructions: string;
  modelId: string;
  testModelResponses?: MockResponseDescriptor[];
}

/**
 * Build the autonomous-run instructions + model config once, in a step, so they stay stable
 * across replays even though the run itself mutates the memory core mid-flight. Uses the shared
 * job-prompt builder (autonomous + memory tools) — same identity, memory semantics, and core as
 * the interactive thread; no host tools/skills (least privilege + anti-recursion, D-SC4). Reads
 * the test-model seam here (in the step, where a test's `globalThis` override is visible) and
 * threads it to the body, so a scheduled run is mockable in the workflow suite.
 */
async function buildSetup(modelId: string): Promise<ScheduledSetup> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { loadCore, memoryPaths } = await import('../src/memory/index.js');
  const { buildJobPrompt } = await import('../src/agent/prompt.js');
  const { testModelResponses } = await import('../src/agent/turnModel.js');
  const { config } = await getRuntime();
  const core = loadCore(memoryPaths(config.runtimeDir));
  return {
    instructions: buildJobPrompt(config, core, '', { autonomous: true, memoryTools: true }),
    modelId,
    testModelResponses: testModelResponses(),
  };
}

async function writeStep(args: {
  file: string;
  action: 'add' | 'replace' | 'remove';
  content?: string;
  target?: string;
}): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execMemoryWrite } = await import('../src/agent/tools/memory.js');
  const { config } = await getRuntime();
  return execMemoryWrite(config, args);
}

async function readTopicStep(name: string): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execReadTopic } = await import('../src/agent/tools/memory.js');
  const { config } = await getRuntime();
  return execReadTopic(config, name);
}

async function recallStep(query: string, limit?: number): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execRecall } = await import('../src/agent/tools/memory.js');
  const { store, config } = await getRuntime();
  return execRecall(store, config, query, limit);
}

async function recordRun(runId: string, output: string): Promise<void> {
  'use step';

  const { eq } = await import('drizzle-orm');
  const { getRuntime } = await import('../src/runtime.js');
  const { scheduleRuns } = await import('../src/db/schema.js');
  const { db } = await getRuntime();
  await db
    .update(scheduleRuns)
    .set({ status: 'completed', output })
    .where(eq(scheduleRuns.id, runId));
}
