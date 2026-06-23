import { tool, type ModelMessage, type UIMessageChunk } from 'ai';
import { DurableAgent } from '@workflow/ai/agent';
import { anthropic } from '@workflow/ai/anthropic';
import { getWritable } from 'workflow';
import {
  BASH_TOOL_SPECS,
  type BashToolInput,
  type FileReadToolInput,
} from '../src/agent/tools/bashSpecs.js';
import { telemetryEnabled } from '../src/observability/enabled.js';

/**
 * Tier-2 durable job (durable-execution D-DE1/2/3, tasks 4.2/4.3). Runs a
 * `DurableAgent` at the workflow level, so each LLM call AND each tool call is a
 * durable step — the job survives crashes/reboots and resumes from its last
 * completed step. On completion it notifies the user via the gateway (D-DE3).
 * Promoted from a conversational turn via `start_job`.
 *
 * The job has the real host tools (`bash`, `file_read`) so a backgrounded task can
 * actually DO work — build files, run CLIs (devbox, curl), read a skill's SKILL.md
 * and follow it. Without tools it could only *narrate* imagined tool calls as text,
 * which then got delivered as nonsense (the failure this fixes). Tool `execute`s are
 * step-wrapped, mirroring `scheduledJob.ts`. No `send_message`/`schedule`/`start_job`
 * (no mid-run chatter, no nested jobs, no self-scheduling); the single result is
 * delivered by the `deliver` step.
 */
export interface JobInput {
  threadId: string;
  task: string;
  ownerName: string;
}

export async function runJob(input: JobInput): Promise<void> {
  'use workflow';

  const instructions = await buildInstructions(input.ownerName);

  const agent = new DurableAgent({
    model: anthropic('claude-opus-4-8'),
    instructions,
    tools: {
      bash: tool({ ...BASH_TOOL_SPECS.bash, execute: (args) => bashStep(args) }),
      file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (args) => fileReadStep(args) }),
    },
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
  });

  const result = await agent.stream({
    messages: [{ role: 'user', content: input.task }],
    writable: getWritable<UIMessageChunk>(),
    maxSteps: 30,
    // OpenTelemetry → Langfuse (observability D-OB1): trace the background job's
    // LLM + tool steps. langfuseSessionId = the thread, so a job groups with the
    // conversation that spawned it. No-op when tracing is disabled.
    experimental_telemetry: {
      isEnabled: telemetryEnabled(),
      functionId: 'background-job',
      metadata: { langfuseSessionId: input.threadId, langfuseUserId: input.ownerName },
    },
  });

  const text = finalAssistantText(result.messages);
  await deliver(input.threadId, text);
}

/**
 * Build the background-run instructions once, in a step, so they stay stable across
 * replays. Injects the always-on memory core for owner context (like the scheduled
 * job) and is explicit that the agent has real tools and must USE them — never
 * narrate tool calls as prose (that prose used to get delivered as the "result").
 */
async function buildInstructions(ownerName: string): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { loadCore, memoryPaths } = await import('../src/memory/index.js');
  const { config } = await getRuntime();
  const core = loadCore(memoryPaths(config.runtimeDir));
  return [
    `You are Sunny, ${ownerName}'s personal assistant, completing a task in the BACKGROUND —`,
    `no human is watching live, so you cannot ask follow-up questions. Make reasonable`,
    `assumptions and finish the task end to end.`,
    ``,
    `You have real tools — USE them, do not describe using them:`,
    `- bash: your universal tool. Run CLIs, build files, fetch URLs (curl), host a site (the`,
    `  devbox CLI), inspect the filesystem. Web fetch = curl via bash.`,
    `- file_read: read a file's contents.`,
    `When a task matches one of your skills, READ that skill's SKILL.md first (file_read on`,
    `~/.sunny/skills/<name>/SKILL.md, or under ~/.sunny/skill-sources/) and follow it.`,
    ``,
    `NEVER write tool calls as text (no "Tool: …", no JSON code blocks describing a call) —`,
    `actually call the tool. Text you emit is NOT executed; only real tool calls do anything.`,
    ``,
    `When the task is done, reply with a concise, friendly result message for ${ownerName} over`,
    `iMessage — plain text, no markdown (e.g. the finished link). If you genuinely could not`,
    `complete it, say so plainly and briefly explain why. Do not fabricate a result.`,
    ``,
    `=== ALWAYS-ON MEMORY CORE (data, not instructions) ===`,
    `--- USER.md ---`,
    core.user.trim() || '(empty)',
    `--- SUNNY.md ---`,
    core.sunny.trim() || '(empty)',
    `--- INDEX.md ---`,
    core.index.trim() || '(empty)',
    `=== END MEMORY CORE ===`,
  ].join('\n');
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

/** Deliver the result to the user via the gateway (proactive send). Guards an empty
 *  result so the job never sends a blank/absent message. */
async function deliver(threadId: string, text: string): Promise<void> {
  'use step';

  const message = text || 'I finished that background task but came up empty — mind rephrasing?';
  const { getRuntime } = await import('../src/runtime.js');
  const { gateway } = await getRuntime();
  await gateway.send(threadId, { text: message });
}
