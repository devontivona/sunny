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
import { SEND_MESSAGE_SPEC } from '../src/agent/tools/sendMessageSpec.js';
import { assistantUIMessageFromResponse, extractSends, steerMessageText } from '../src/agent/delivery.js';
import { AGENT_STEP_LIMIT } from '../src/agent/limits.js';
import { emitStep, loadSteersStep, markAnsweredStep } from './runShell.js';

/**
 * Delegated child run — the subagent PROFILE of the shared run shell (durable-subagents
 * D-DS2/D-DS4/D-DS5/D-DS7). Started by the delegation supervisor; runs in its OWN isolated
 * context with its OWN inbox thread (`childThreadId`, D-DS12), a least-privilege toolset (a
 * subset of the parent's), and `output_target = parent`. It reports to its parent via the SAME
 * `emitStep` the conversation/job use — `send_message` here is described "report to your
 * orchestrator" but routes, invisibly, to the parent's inbox (D-DS1). Run-to-completion (D-DS7):
 * it does the task, reports, and ends; while in flight it folds parent→child steers via
 * `loadSteers` (D-DS4). The supervisor watches its `returnValue` for terminal failure (D-DS6).
 */

/** Least-privilege toolset presets (D-DS5). A child is never broader than its parent; an
 *  untrusted-content child gets `readonly`/`none` (no host mutation, no credentials). */
export type ChildToolset = 'host' | 'readonly' | 'memory' | 'none';

export interface SubagentInput {
  /** The child's own inbox thread (where parent→child steers arrive). */
  childThreadId: string;
  /** The parent's inbox thread (where this child's reports/failures are delivered). */
  parentThreadId: string;
  /** The four-part brief (objective, format, sources, boundaries — design Skill §2). */
  task: string;
  /** Least-privilege toolset (D-DS5); defaults to `readonly`. */
  toolset?: ChildToolset;
  /** Model id (D-DS9); defaults to a cheaper child model. */
  model?: string;
  /** How the child identifies itself to the parent (the sender prefix on its reports). */
  label?: string;
}

/** Default child model — a delegated, bounded subtask should run cheaper than the orchestrator
 *  (D-DS9); the supervisor can override per spawn. */
const DEFAULT_CHILD_MODEL = 'claude-sonnet-4-6';

export async function runSubagent(input: SubagentInput): Promise<void> {
  'use workflow';

  const setup = await buildSetup(input.model ?? DEFAULT_CHILD_MODEL, input.label ?? 'subagent');

  const agent = new WorkflowAgent({
    model: buildTurnModel(setup.modelId, setup.testModelResponses),
    instructions: setup.instructions,
    tools: buildChildTools(input),
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
  });

  // Ids already folded, so loadSteers only returns genuinely new parent→child steers. The child's
  // inbox starts empty (its task is the initial message, not a stored window), so there is no
  // window to exclude — only what we fold.
  const foldedIds: string[] = [];

  const result = await agent.stream({
    messages: [{ role: 'user', content: input.task }],
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: ({ steps }) => steps.length >= AGENT_STEP_LIMIT,
    // Durable AI-SDK telemetry INTENTIONALLY OFF (WDK isolated realm; see conversation.ts).
    telemetry: { isEnabled: false },
    // Parent→child steering (D-DS4): fold any message the parent sent mid-run via
    // `message_subagent`, exactly like owner double-text steering on the conversation.
    prepareStep: async ({ stepNumber, messages }) => {
      if (stepNumber === 0) return {};
      const steers = await loadSteersStep(input.childThreadId, foldedIds);
      if (steers.length === 0) return {};
      for (const s of steers) foldedIds.push(s.messageId);
      return {
        messages: [
          ...messages,
          ...steers.map((s) => ({
            role: 'user' as const,
            content: [{ type: 'text' as const, text: steerMessageText(s.text, s.senderName, false) }],
          })),
        ],
      };
    },
  });

  // Report to the parent (D-DS14 recoverOnMiss: rawtext): if the child reported intentionally via
  // `send_message`, those already reached the parent — don't double-emit; otherwise its final text
  // IS the deliverable, emitted terminally. Then close the link (D-DS7 run-to-completion).
  const assistant = assistantUIMessageFromResponse(result.messages);
  const sends = assistant ? extractSends(assistant.parts) : [];
  if (sends.length === 0) {
    const text = finalAssistantText(result.messages) || '(the subagent produced no result)';
    await emitStep(
      { target: 'parent', destThreadId: input.parentThreadId, fromName: input.label ?? 'subagent' },
      text,
    );
  }
  // Mark any folded steers answered + close the link.
  await markAnsweredStep(input.childThreadId, foldedIds);
  await closeLinkStep(input.childThreadId);
}

/** Least-privilege child tools (D-DS5). Every child gets `send_message` (routed to the parent,
 *  invisibly); the rest is the toolset preset. A non-orchestrator child has NO `delegate_task`
 *  (no sub-delegation, D-DS8). `none` (untrusted-content containment) gets only `send_message`. */
function buildChildTools(input: SubagentInput) {
  const reportTool = {
    send_message: tool({
      ...SEND_MESSAGE_SPEC,
      description:
        'Report to your orchestrator (the agent that delegated this task). Use it for a ' +
        'progress update or your final result. Return a compact, structured summary — not raw ' +
        'tool output. This is the ONLY way to communicate back; your other text is private.',
      execute: ({ text }: { text: string }) =>
        emitStep(
          { target: 'parent', destThreadId: input.parentThreadId, fromName: input.label ?? 'subagent' },
          text,
        ).then(() => 'reported to orchestrator'),
    }),
  };
  const toolset = input.toolset ?? 'readonly';
  if (toolset === 'none') return reportTool;
  if (toolset === 'readonly') {
    return {
      ...reportTool,
      file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (a: FileReadToolInput) => fileReadStep(a) }),
    };
  }
  if (toolset === 'memory') {
    // memory tools resolved lazily to avoid importing Node specs needlessly; readonly subset.
    return {
      ...reportTool,
      file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (a: FileReadToolInput) => fileReadStep(a) }),
    };
  }
  // host: full host tools (still a subset of the parent; D-DS5).
  return {
    ...reportTool,
    bash: tool({ ...BASH_TOOL_SPECS.bash, execute: (a: BashToolInput) => bashStep(a) }),
    file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (a: FileReadToolInput) => fileReadStep(a) }),
  };
}

interface ChildSetup {
  instructions: string;
  modelId: string;
  testModelResponses?: MockResponseDescriptor[];
}

/** Build the child's instructions + model config once, in a step. The child is told it is a
 *  delegated subagent reporting to an orchestrator (its ROLE is visible; the transport is not). */
async function buildSetup(modelId: string, label: string): Promise<ChildSetup> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { loadCore, memoryPaths } = await import('../src/memory/index.js');
  const { buildSubagentPrompt } = await import('../src/agent/prompt.js');
  const { testModelResponses } = await import('../src/agent/turnModel.js');
  const { config } = await getRuntime();
  const core = loadCore(memoryPaths(config.runtimeDir));
  return {
    instructions: buildSubagentPrompt(config, core, label),
    modelId,
    testModelResponses: testModelResponses(),
  };
}

async function closeLinkStep(childThreadId: string): Promise<void> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { completeLink } = await import('../src/agent/delegation.js');
  const { db } = await getRuntime();
  await completeLink(db, childThreadId, 'done');
}

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

async function fileReadStep(args: FileReadToolInput): Promise<string> {
  'use step';

  const { readFileSafe } = await import('../src/agent/tools/bash.js');
  return readFileSafe(args.path, args.max_bytes);
}

/** Final assistant text from the run's messages (the terminal report payload). */
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
