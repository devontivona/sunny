import { tool } from '@ai-sdk/provider-utils';
import { buildTurnModel, type MockResponseDescriptor } from '../src/agent/turnModel.js';
import {
  BASH_TOOL_SPECS,
  type BashToolInput,
  type FileReadToolInput,
} from '../src/agent/tools/bashSpecs.js';
import { SEND_MESSAGE_SPEC } from '../src/agent/tools/sendMessageSpec.js';
import { assistantUIMessageFromResponse, extractSends } from '../src/agent/delivery.js';
import {
  bashStep,
  deliver,
  fileReadStep,
  finalAssistantText,
  markAnsweredStep,
  streamAgent,
} from './runShell.js';

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
export type ChildToolset = 'host' | 'readonly' | 'none';

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

  // Steerable run (D-DS4): fold parent→child steers (`message_subagent`) that arrive on the
  // child's own inbox thread, exactly like owner double-text steering on the conversation. The
  // child's inbox starts empty (its brief is the initial message, not a stored window), so the
  // base exclude set is empty — only what we fold.
  const { result, foldedIds } = await streamAgent({
    model: buildTurnModel(setup.modelId, setup.testModelResponses),
    instructions: setup.instructions,
    tools: buildChildTools(input),
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
    messages: [{ role: 'user', content: input.task }],
    steering: { inboxThreadId: input.childThreadId, isGroup: false, baseExcludeIds: [] },
  });

  // Report to the parent (D-DS14 recoverOnMiss: rawtext): if the child reported intentionally via
  // `send_message`, those already reached the parent — don't double-emit; otherwise its final text
  // IS the deliverable, emitted terminally. But if the parent `cancel_run`'d this child mid-flight
  // (link no longer `running`), SUPPRESS the terminal report — "it will stop reporting" must be
  // true, not a lie. Then close the link (D-DS7 run-to-completion; `completeLink` no-ops on a
  // cancelled link, so the cancellation stays recorded).
  const stillRunning = await linkRunningStep(input.childThreadId);
  const assistant = assistantUIMessageFromResponse(result.messages);
  const sends = assistant ? extractSends(assistant.parts) : [];
  if (stillRunning && sends.length === 0) {
    const text = finalAssistantText(result.messages) || '(the subagent produced no result)';
    await deliver(
      { kind: 'parent', threadId: input.parentThreadId, fromName: input.label ?? 'subagent' },
      text,
    );
  }
  // Mark any folded steers answered + close the link.
  await markAnsweredStep(input.childThreadId, foldedIds);
  await closeLinkStep(input.childThreadId);
}

/** Whether this child's link is still `running` — false once the parent `cancel_run`'d it, so the
 *  child suppresses its terminal report (Phase 3.2 cancel is honest). `'use step'`. */
async function linkRunningStep(childThreadId: string): Promise<boolean> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { getLinkByChildThread } = await import('../src/agent/delegation.js');
  const { db } = await getRuntime();
  const link = await getLinkByChildThread(db, childThreadId);
  return link?.status === 'running';
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
        deliver(
          { kind: 'parent', threadId: input.parentThreadId, fromName: input.label ?? 'subagent' },
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
