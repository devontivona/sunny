import type { ModelCallStreamPart, ModelMessage } from '../src/agent/aiTypes.js';
import { tool } from '@ai-sdk/provider-utils';
import { WorkflowAgent } from '@ai-sdk/workflow';
import { buildModel } from '../src/agent/turnModel.js';
import { getWritable } from 'workflow';
import { MEMORY_TOOL_SPECS } from '../src/agent/tools/memorySpecs.js';
import { telemetryEnabled } from '../src/observability/enabled.js';
import { AGENT_STEP_LIMIT } from '../src/agent/limits.js';

/**
 * Durable job for a fired schedule (scheduling D-SC2/5, task 4.6). Runs an
 * autonomous `DurableAgent` (D-DE1/2): each LLM call and tool call is a durable
 * workflow step, so a crash mid-run resumes from the last completed step instead
 * of re-running the whole agent.
 *
 * MEMORY tools only — no send_message, no schedule tools, no start_job — which
 * enforces the anti-recursion guard (D-SC4: a scheduled run cannot create
 * schedules) and least privilege by construction. Tool `execute` is step-wrapped
 * so a replay never re-applies a non-idempotent `memory_write` (add appends).
 * Output is delivered by the deliver step (D-SC5) and the outcome is recorded.
 */
export interface ScheduledJobInput {
  scheduleId: string;
  runId: string;
  threadId: string;
  prompt: string;
  ownerName: string;
}

export async function runScheduledJob(input: ScheduledJobInput): Promise<void> {
  'use workflow';

  const instructions = await buildInstructions();

  const agent = new WorkflowAgent({
    model: buildModel('claude-opus-4-8'),
    instructions,
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
    // OpenTelemetry → Langfuse (observability D-OB1): group with the thread's session. v7
    // carries this via runtimeContext (the v6 telemetry.metadata channel was removed).
    runtimeContext: { langfuseSessionId: input.threadId, scheduleId: input.scheduleId },
  });

  // WorkflowAgent writes raw model-call parts to the durable run stream; the dashboard reader
  // converts them to UIMessageChunk (design 3.1 — transform runs at the reader, not the sandbox).
  const result = await agent.stream({
    messages: [{ role: 'user', content: input.prompt }],
    writable: getWritable<ModelCallStreamPart>(),
    // No work cap — runaway backstop only.
    stopWhen: ({ steps }) => steps.length >= AGENT_STEP_LIMIT,
    // Trace the scheduled run's LLM + memory-tool steps. No-op when tracing is disabled.
    telemetry: {
      isEnabled: telemetryEnabled(),
      functionId: 'scheduled-job',
      includeRuntimeContext: { langfuseSessionId: true, scheduleId: true },
    },
  });

  const text = finalAssistantText(result.messages);
  await recordRun(input.runId, text);
  await deliverScheduled(input.threadId, text);
}

/**
 * Build the autonomous-run instructions once, in a step, so they stay stable across
 * replays even though the run itself mutates the memory core mid-flight. Uses the
 * shared job-prompt builder (autonomous + memory tools) — same identity, memory
 * semantics, and core as the interactive thread; no host tools/skills (least
 * privilege + anti-recursion, D-SC4). The task itself comes from the schedule prompt.
 */
async function buildInstructions(): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { loadCore, memoryPaths } = await import('../src/memory/index.js');
  const { buildJobPrompt } = await import('../src/agent/prompt.js');
  const { config } = await getRuntime();
  const core = loadCore(memoryPaths(config.runtimeDir));
  return buildJobPrompt(config, core, '', { autonomous: true, memoryTools: true });
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
  const { store } = await getRuntime();
  return execRecall(store, query, limit);
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

async function deliverScheduled(threadId: string, text: string): Promise<void> {
  'use step';

  if (!text) return;
  const { getRuntime } = await import('../src/runtime.js');
  const { gateway } = await getRuntime();
  await gateway.send(threadId, { text });
}
