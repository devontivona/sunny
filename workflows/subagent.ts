import { tool } from '@ai-sdk/provider-utils';
import { buildTurnModel, type MockResponseDescriptor } from '../src/agent/turnModel.js';
import {
  BASH_TOOL_SPECS,
  type BashToolInput,
  type FileReadToolInput,
} from '../src/agent/tools/bashSpecs.js';
import { extractReportBlocks, stripNoReport } from '../src/agent/delivery.js';
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
 * subset of the parent's), and `output_target = parent`. Its speech is TEXT (subagent
 * text-unification): the FINAL assistant text IS the report, delivered terminally to the
 * parent's inbox via the shared bus; mid-task progress is explicit `<report>…</report>` blocks
 * delivered at step boundaries while the child keeps working; a `<no-report/>` sentinel final
 * delivers nothing. Run-to-completion (D-DS7): it does the task, reports, and ends; while in
 * flight it folds parent→child steers via `loadSteers` (D-DS4). The supervisor watches its
 * `returnValue` for terminal failure (D-DS6).
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
const DEFAULT_CHILD_MODEL = 'claude-sonnet-5';

export async function runSubagent(input: SubagentInput): Promise<void> {
  'use workflow';

  const setup = await buildSetup(input.model ?? DEFAULT_CHILD_MODEL, input.label ?? 'subagent');

  // Steerable run (D-DS4): fold parent→child steers (`message_subagent`) that arrive on the
  // child's own inbox thread, exactly like owner double-text steering on the conversation. The
  // child's inbox starts empty (its brief is the initial message, not a stored window), so the
  // base exclude set is empty — only what we fold.
  const parentAudience = {
    kind: 'parent',
    threadId: input.parentThreadId,
    fromName: input.label ?? 'subagent',
  } as const;
  const { result, foldedIds, reportsSent } = await streamAgent({
    model: buildTurnModel(setup.modelId, setup.testModelResponses),
    instructions: setup.instructions,
    tools: buildChildTools(input),
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
    messages: [{ role: 'user', content: input.task }],
    steering: { inboxThreadId: input.childThreadId, isGroup: false, baseExcludeIds: [] },
    // Mid-task <report> blocks deliver to the parent as they complete (memoized bus step).
    reportBlocks: { send: (text) => deliver(parentAudience, text) },
  });

  // Terminal report (subagent text-unification): the child's FINAL text IS its report —
  // the same shape as a Tier-2 job. Blocks in the final text were never seen by the
  // step-boundary scan (no prepareStep follows the last step), so deliver them here, then
  // the remaining text as the report. A bare <no-report/> sentinel delivers nothing (the
  // deliberate no-op). An empty final WITHOUT the sentinel falls back to the raw interim
  // narration (a parent-agent reads messy notes better than a placeholder; no model pass),
  // then the fixed notice. If the parent `cancel_run`'d this child mid-flight (link no
  // longer `running`), SUPPRESS all terminal delivery — "it will stop reporting" must be
  // true, not a lie. Then close the link (D-DS7; `completeLink` no-ops on a cancelled link).
  const stillRunning = await linkRunningStep(input.childThreadId);
  const { reports: finalBlocks, rest } = extractReportBlocks(finalAssistantText(result.messages));
  const parsed = stripNoReport(rest);
  let delivered: 'text' | 'silence' | 'fallback_text' = 'silence';
  if (stillRunning) {
    for (const report of finalBlocks) {
      await deliver(parentAudience, report);
    }
    if (parsed.text) {
      await deliver(parentAudience, parsed.text);
      delivered = 'text';
    } else if (!parsed.sentinel && finalBlocks.length === 0 && reportsSent.length === 0) {
      const fallback = interimNarration(result) || '(the subagent produced no result)';
      await deliver(parentAudience, fallback);
      delivered = 'fallback_text';
    }
  }
  // Mark any folded steers answered + close the link (recording the delivery telemetry).
  await markAnsweredStep(input.childThreadId, foldedIds);
  await closeLinkStep(input.childThreadId, delivered);
}

/** The child's interim narration (text written between tool calls, all steps but any final
 *  reply) — the empty-final fallback report (D-DS14 recoverOnMiss: rawtext posture). */
function interimNarration(result: { steps: Array<{ content: unknown }> }): string {
  const texts: string[] = [];
  for (const s of result.steps) {
    if (!Array.isArray(s.content)) continue;
    for (const p of s.content as Array<{ type: string; text?: string }>) {
      if (p.type === 'text' && p.text?.trim()) texts.push(p.text.trim());
    }
  }
  return texts.join('\n').trim();
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

/** Least-privilege child tools (D-DS5). The child SPEAKS in text (final report + <report>
 *  blocks), so there is no report tool — the toolset preset is the whole toolset, and `none`
 *  (untrusted-content containment) is genuinely tool-less. A non-orchestrator child has NO
 *  `delegate_task` (no sub-delegation, D-DS8). */
function buildChildTools(input: SubagentInput): Parameters<typeof streamAgent>[0]['tools'] {
  const toolset = input.toolset ?? 'readonly';
  if (toolset === 'none') return {};
  if (toolset === 'readonly') {
    return {
      file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (a: FileReadToolInput) => fileReadStep(a) }),
    };
  }
  // host: full host tools (still a subset of the parent; D-DS5).
  return {
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

async function closeLinkStep(
  childThreadId: string,
  delivered: 'text' | 'silence' | 'fallback_text',
): Promise<void> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { completeLink } = await import('../src/agent/delegation.js');
  const { logger } = await import('../src/logger.js');
  const { db } = await getRuntime();
  // Telemetry: the child's outcome in the text-mode vocabulary — one delivery language
  // across every run profile. fallback_text = the raw-narration rescue fired.
  logger('subagent').info('child run closed', { childThreadId, delivered });
  await completeLink(db, childThreadId, 'done');
}
