import { tool } from '@ai-sdk/provider-utils';
import { buildTurnModel, type MockResponseDescriptor } from '../src/agent/turnModel.js';
import { MESSAGE_SPEC } from '../src/agent/tools/messageSpec.js';
import { SEND_IMAGE_SPEC } from '../src/agent/tools/sendImageSpec.js';
import { type Audience, subjectName } from '../src/agent/audience.js';
import { stripNoReply } from '../src/agent/delivery.js';
import type { McpToolDef } from '../src/mcp/turnTools.js';
import { deliver, finalAssistantText, grantTools, streamAgent } from './runShell.js';

/**
 * Durable job for a fired schedule — the scheduled-job PROFILE of the shared run shell
 * (scheduling D-SC2/5; durable-subagents D-DS11/D-DS14). Runs an autonomous `WorkflowAgent`
 * (D-DE1/2): each LLM call and tool call is a durable workflow step, so a crash mid-run resumes
 * from the last completed step instead of re-running the whole agent.
 *
 * The run's toolset is its stored AUTHORITY ({ audience, authority } — tool-access spec): the
 * grants the creating turn endowed at `schedule_create` (derived from the `toolset` preset —
 * the same host/readonly vocabulary as delegate_task — attenuated against the creator), mapped
 * through the shared `grantTools` builder. Legacy rows (null authority, pre-preset) get the
 * memory tools. How the run SPEAKS is the AUDIENCE axis, not a grant: every scheduled run can
 * `message` the roster (a household run's only voice — its terminal result is recorded, not
 * sent), and delivering runs get `send_image`. No `schedule`/`delegate` grants ever
 * (anti-recursion, D-SC4 — a scheduled run
 * cannot create schedules or spawn children). Tool `execute`s are step-wrapped so a replay
 * never re-applies a non-idempotent action. The outcome is always recorded (`recordRun`); the
 * reply is reported to the schedule's audience via the shared bus — so a `household`
 * maintenance schedule (nightly memory consolidation) records its result but sends NO 2am text.
 */
export interface ScheduledJobInput {
  scheduleId: string;
  runId: string;
  prompt: string;
  ownerName: string;
  /** Who the fired run is for — resolved to a delivery thread through the bus (run-audiences
   *  D-RA2). `household` = record-only (structurally silent, e.g. nightly consolidation). */
  audience: Audience;
  /** The grants this run is endowed (D-RA5); omitted → the memory-maintenance default. */
  authority?: string[];
  /** Model id for this run (D-DS9); defaults to the standard job model. */
  model?: string;
}

/** Default model for a scheduled run; overridable per run (D-DS9). */
const DEFAULT_SCHEDULED_MODEL = 'claude-opus-4-8';

/** Legacy grants (rows created before stored authority existed): the memory tools —
 *  the old scheduled-run profile. New rows always store explicit grants. */
const DEFAULT_SCHEDULE_GRANTS = ['memory_read', 'memory_write'];

export async function runScheduledJob(input: ScheduledJobInput): Promise<void> {
  'use workflow';

  const grants = input.authority ?? DEFAULT_SCHEDULE_GRANTS;
  const setup = await buildSetup(input.model ?? DEFAULT_SCHEDULED_MODEL, input.audience, grants);

  const { result } = await streamAgent({
    // `observe` gives the fired run exactly-once generation spans in Langfuse. Session = the
    // audience's thread when it has one; otherwise group the schedule's firings together.
    model: buildTurnModel(setup.modelId, setup.testModelResponses, {
      functionId: 'scheduled-job',
      sessionId:
        input.audience.kind === 'thread' ? input.audience.threadId : `schedule:${input.scheduleId}`,
    }),
    instructions: setup.instructions,
    tools: {
      // Grant-mapped tools (the shared builder): memory, host, registries, live MCP tools.
      // ownerScope: a scheduled run may edit the owner-core files only when it acts FOR the
      // owner (a household/owner-audience run, e.g. consolidation) — never for a family subject.
      ...grantTools(grants, {
        ownerScope: setup.subject === input.ownerName,
        runs: {
          threadId: input.audience.kind === 'thread' ? input.audience.threadId : '',
          subject: setup.subject,
        },
        mcpTools: setup.mcpTools,
      }),
      // How the run SPEAKS is the AUDIENCE axis, never a grant (D-RA14 revised 2026-07-07):
      // - message: EVERY scheduled run can deliberately fan out to roster members — including a
      //   household run (whose terminal result is recorded only; the message tool is its one way
      //   to reach people, e.g. a household job briefing each member). Roster-only; a delivering
      //   run is refused its OWN subject (that person gets the terminal result — no double-send).
      // - send_image: delivering (thread/person) audiences get the one outbound-media verb, same
      //   as the conversation profile — a household run has no single recipient for it.
      message: tool({
        ...MESSAGE_SPEC,
        execute: ({ recipient, text }) => scheduledMessageStep(input.audience, recipient, text),
      }),
      ...(input.audience.kind !== 'household'
        ? {
            send_image: tool({
              ...SEND_IMAGE_SPEC,
              execute: ({ pathOrUrl, caption }) =>
                scheduledSendImageStep(input.audience, caption ?? '', pathOrUrl),
            }),
          }
        : {}),
    },
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
    messages: [{ role: 'user', content: input.prompt }],
  });

  // Record-always ⟂ emit-by-target (D-DS14): the outcome is recorded regardless of output target
  // (so a `silent` run is still inspectable), then reported only when not silent. `recoverOnMiss:
  // 'rawtext'` — the agent's final text is the deliverable. Silence is the same <no-reply/>
  // sentinel as the conversation profile (unified 2026-07-13): its presence means the run has
  // nothing to send — the RAW text (sentinel and any working notes included) still lands in
  // `schedule_runs`, but nothing reaches the audience.
  const text = finalAssistantText(result.messages);
  await recordRun(input.runId, text);
  await deliver(input.audience, stripNoReply(text).text);
}

interface ScheduledSetup {
  instructions: string;
  modelId: string;
  /** The audience's canonical subject name (resolved in the step, where config is visible). */
  subject: string;
  /** Live MCP server tool defs (mcp D-MCP6/7) — discovered here only when the run holds the
   *  `mcp` grant; plain data, so it journals across the step boundary. */
  mcpTools?: McpToolDef[];
  testModelResponses?: MockResponseDescriptor[];
}

/**
 * Build the autonomous-run instructions + model config once, in a step, so they stay stable
 * across replays even though the run itself mutates the memory core mid-flight. Uses the shared
 * job-prompt builder — same identity, memory semantics, core, and SKILLS index as the interactive
 * thread — with the prompt's tool sections gated on the run's actual grants. When the run holds
 * the `mcp` grant, the enabled MCP servers' tools are discovered here (the same journaled-defs
 * seam as the owner-DM turn); connect failures degrade to a log line and never fail the run.
 * Reads the test-model seam here (in the step, where a test's `globalThis` override is visible)
 * and threads it to the body, so a scheduled run is mockable in the workflow suite.
 */
async function buildSetup(
  modelId: string,
  audience: Audience,
  grants: string[],
): Promise<ScheduledSetup> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { loadCore, memoryPaths } = await import('../src/memory/index.js');
  const { loadAllSkills, renderSkillIndex } = await import('../src/skills/index.js');
  const { buildJobPrompt } = await import('../src/agent/prompt.js');
  const { testModelResponses } = await import('../src/agent/turnModel.js');
  const { config } = await getRuntime();
  const core = loadCore(memoryPaths(config.runtimeDir));
  const skillsIndex = renderSkillIndex(loadAllSkills(config), config.skills);
  // Frame the run for its subject (D-RA4), derived from the audience — a schedule fired in Kate's
  // thread reports for Kate, not the owner. `household` (consolidation) → owner framing.
  const subject = subjectName(audience, config);

  // Live MCP tool discovery (mcp D-MCP6/7) — only for runs endowed the `mcp` grant. No owner
  // notice channel here (the run is unattended); failures log and degrade to no tools.
  let mcpTools: McpToolDef[] | undefined;
  if (grants.includes('mcp')) {
    const { discoverMcpToolDefs } = await import('../src/mcp/turnTools.js');
    const { resolverFromEnv } = await import('../src/credentials/index.js');
    const { logger } = await import('../src/logger.js');
    mcpTools = await discoverMcpToolDefs(config, resolverFromEnv() ?? undefined, (text) => {
      logger('scheduled-job').warn('mcp notice (unattended run)', { text });
    });
  }

  return {
    instructions: buildJobPrompt(config, core, skillsIndex, {
      autonomous: true,
      memoryTools: grants.includes('memory_read') || grants.includes('memory_write'),
      hostTools: grants.includes('bash'),
      subject,
    }),
    modelId,
    subject,
    mcpTools,
    testModelResponses: testModelResponses(),
  };
}

/**
 * Proactively message a roster member from a scheduled run (run-audiences D-RA10, Phase 3.1).
 * Self-contained `'use step'` (resolves via the shared `resolveRosterMember`, sends via the gateway
 * inline) so it composes as a tool execute without nesting the `deliver` step. Roster-only. A
 * DELIVERING run is refused its OWN audience subject — that person is reached by the terminal
 * result, so self-messaging would double-send. A HOUSEHOLD run has no terminal delivery, so it may
 * message anyone on the roster (fan-out is its only voice).
 */
async function scheduledMessageStep(
  audience: Audience,
  recipient: string,
  text: string,
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { resolveRosterMember, resolveMemberThread } = await import('../src/agent/audience.js');
  const { config, store, gateway } = await getRuntime();

  const member = resolveRosterMember(recipient, config);
  if (!member) {
    const known = [config.owner.name, ...config.family.map((f) => f.name)].join(', ');
    return `I can only message the family roster (${known}); "${recipient}" isn't one, so I sent nothing.`;
  }
  // No self-send on a DELIVERING run: its own subject already receives the terminal result.
  // A household run delivers nothing terminally, so nobody is excluded.
  if (audience.kind !== 'household' && member.name === subjectName(audience, config)) {
    return `${member.name} already receives this run's result — put it in your final reply instead of messaging them.`;
  }
  // Existing DM if we have one, else a constructed Sendblue DM id (shared resolve tail). Null ⟺
  // no thread AND no from-number.
  const threadId = await resolveMemberThread(store, member.identity);
  if (!threadId) return `I don't have a conversation with ${member.name} yet and can't start one.`;
  await gateway.send(threadId, { text }, { persist: true });
  return `Sent to ${member.name}.`;
}

/**
 * Send an image from a delivering scheduled run to its OWN audience (the audience axis's one
 * outbound-media verb, mirroring the conversation profile — e.g. a daily chart). Resolves the
 * audience to its bound thread the same way the terminal `deliver` does: thread → direct;
 * person → roster member's DM. `'use step'` — a replay never re-sends.
 */
async function scheduledSendImageStep(
  audience: Audience,
  caption: string,
  pathOrUrl: string,
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { resolveRosterMember, resolveMemberThread } = await import('../src/agent/audience.js');
  const { config, store, gateway } = await getRuntime();

  let threadId: string | null = null;
  if (audience.kind === 'thread') threadId = audience.threadId;
  else if (audience.kind === 'person') {
    const member = resolveRosterMember(audience.person, config);
    if (member) threadId = await resolveMemberThread(store, member.identity);
  }
  if (!threadId) return `I can't resolve where to send that image, so I sent nothing.`;
  await gateway.send(threadId, { text: caption, attachment: { pathOrUrl } }, { persist: true });
  return 'Image sent.';
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
