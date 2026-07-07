import { buildTurnModel, type MockResponseDescriptor } from '../src/agent/turnModel.js';
import { authorityForToolset } from '../src/agent/audience.js';
import type { McpToolDef } from '../src/mcp/turnTools.js';
import { extractReportBlocks, stripNoReport } from '../src/agent/delivery.js';
import {
  deliver,
  finalAssistantText,
  grantTools,
  markAnsweredStep,
  streamAgent,
} from './runShell.js';

/**
 * Delegated child run — the subagent PROFILE of the shared run shell (durable-subagents
 * D-DS2/D-DS4/D-DS5/D-DS7). Started by the delegation supervisor; runs in its OWN isolated
 * context with its OWN inbox thread (`childThreadId`, D-DS12), a least-privilege toolset (its
 * grants are the toolset preset's, attenuated against the parent's authority at spawn — D-RA5),
 * and `output_target = parent`. Its speech is TEXT (subagent text-unification): the FINAL
 * assistant text IS the report, delivered terminally to the parent's inbox via the shared bus;
 * mid-task progress is explicit `<report>…</report>` blocks delivered at step boundaries while
 * the child keeps working; a `<no-report/>` sentinel final delivers nothing. Run-to-completion
 * (D-DS7): it does the task, reports, and ends; while in flight it folds parent→child steers via
 * `loadSteers` (D-DS4). The supervisor watches its `returnValue` for terminal failure (D-DS6).
 */

/** Least-privilege toolset presets (D-DS5): `host` (the default — full grant bundle, attenuated
 *  by the parent) or `readonly` (reads only — reserve for work that must be handled with extra
 *  care, e.g. triaging untrusted content). */
export type ChildToolset = 'host' | 'readonly';

export interface SubagentInput {
  /** The child's own inbox thread (where parent→child steers arrive). */
  childThreadId: string;
  /** The parent's inbox thread (where this child's reports/failures are delivered). */
  parentThreadId: string;
  /** The four-part brief (objective, format, sources, boundaries — design Skill §2). */
  task: string;
  /** Least-privilege toolset (D-DS5); defaults to `host`. */
  toolset?: ChildToolset;
  /** The child's grants, already attenuated against the parent's authority by the supervisor
   *  (D-RA5). Omitted (direct/test callers) → the toolset preset's full bundle. */
  authority?: string[];
  /** Whether the spawning context may edit the owner-core files (USER.md/SUNNY.md) — inherited,
   *  never broader than the parent's. Defaults false (restrictive). */
  ownerScope?: boolean;
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

  const grants = input.authority ?? authorityForToolset(input.toolset);
  const setup = await buildSetup(
    input.model ?? DEFAULT_CHILD_MODEL,
    input.label ?? 'subagent',
    grants,
  );

  // Steerable run (D-DS4): fold parent→child steers (`message`) that arrive on the child's own
  // inbox thread, exactly like owner double-text steering on the conversation. The child's inbox
  // starts empty (its brief is the initial message, not a stored window), so the base exclude
  // set is empty — only what we fold.
  const parentAudience = {
    kind: 'parent',
    threadId: input.parentThreadId,
    fromName: input.label ?? 'subagent',
  } as const;
  const { result, foldedIds, reportsSent } = await streamAgent({
    // `observe` gives the child exactly-once generation spans in Langfuse, sessioned under the
    // PARENT thread so the whole delegation tree groups with the conversation that spawned it.
    model: buildTurnModel(setup.modelId, setup.testModelResponses, {
      functionId: 'subagent-run',
      sessionId: input.parentThreadId,
    }),
    instructions: setup.instructions,
    // The child's whole toolset is its grants through the SHARED builder (D-DS5) — no
    // profile-specific verbs: it has no `message` (it speaks via report text), no
    // `delegate_task` (no sub-delegation, D-DS8), no scheduling (D-SC4). `runs` scopes
    // `list_runs` to the parent's conversation (its siblings).
    tools: grantTools(grants, {
      ownerScope: input.ownerScope ?? false,
      runs: { threadId: input.parentThreadId, subject: input.label ?? 'subagent' },
      mcpTools: setup.mcpTools,
    }),
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
    messages: [{ role: 'user', content: input.task }],
    steering: { inboxThreadId: input.childThreadId, isGroup: false, baseExcludeIds: [] },
    // Mid-task <report> blocks deliver to the parent as they complete (memoized bus step).
    reportBlocks: { send: (text) => deliver(parentAudience, text) },
  });

  // Terminal report (subagent text-unification): the child's FINAL text IS its report —
  // the same shape as a scheduled run's deliverable. Blocks in the final text were never seen
  // by the step-boundary scan (no prepareStep follows the last step), so deliver them here,
  // then the remaining text as the report. A bare <no-report/> sentinel delivers nothing (the
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

interface ChildSetup {
  instructions: string;
  modelId: string;
  /** Live MCP server tool defs — discovered here only when the child holds the `mcp` grant
   *  (i.e. a host child of an owner-scoped parent); plain data, journals across the boundary. */
  mcpTools?: McpToolDef[];
  testModelResponses?: MockResponseDescriptor[];
}

/** Build the child's instructions + model config once, in a step. The child is told it is a
 *  delegated subagent reporting to an orchestrator (its ROLE is visible; the transport is not).
 *  Includes the full SKILLS index — a child acts on skills exactly like every other profile.
 *  When the child holds the `mcp` grant, the enabled MCP servers' tools are discovered here
 *  (journaled defs; failures log and degrade to no tools). */
async function buildSetup(modelId: string, label: string, grants: string[]): Promise<ChildSetup> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { loadCore, memoryPaths } = await import('../src/memory/index.js');
  const { loadAllSkills, renderSkillIndex } = await import('../src/skills/index.js');
  const { buildSubagentPrompt } = await import('../src/agent/prompt.js');
  const { testModelResponses } = await import('../src/agent/turnModel.js');
  const { config } = await getRuntime();
  const core = loadCore(memoryPaths(config.runtimeDir));
  const skillsIndex = renderSkillIndex(loadAllSkills(config), config.skills);

  let mcpTools: McpToolDef[] | undefined;
  if (grants.includes('mcp')) {
    const { discoverMcpToolDefs } = await import('../src/mcp/turnTools.js');
    const { resolverFromEnv } = await import('../src/credentials/index.js');
    const { logger } = await import('../src/logger.js');
    mcpTools = await discoverMcpToolDefs(config, resolverFromEnv() ?? undefined, (text) => {
      logger('subagent').warn('mcp notice (child run)', { text });
    });
  }

  return {
    instructions: buildSubagentPrompt(config, core, label, skillsIndex),
    modelId,
    mcpTools,
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
