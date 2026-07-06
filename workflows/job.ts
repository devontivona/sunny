import { tool } from '@ai-sdk/provider-utils';
import { buildTurnModel, type MockResponseDescriptor } from '../src/agent/turnModel.js';
import { BASH_TOOL_SPECS } from '../src/agent/tools/bashSpecs.js';
import { FILE_TOOL_SPECS } from '../src/agent/tools/fileSpecs.js';
import {
  bashStep,
  deliver,
  fileEditStep,
  fileReadStep,
  fileWriteStep,
  finalAssistantText,
  streamAgent,
} from './runShell.js';

/**
 * Tier-2 durable job — the background-job PROFILE of the shared run shell (durable-subagents
 * D-DS11/D-DS14). Runs the shared `streamAgent` loop, so each LLM call AND each tool call is a
 * durable step — the job survives crashes/reboots and resumes from its last completed step. On
 * completion it reports to its configured `output_target` (D-DS1) via the shared `emitStep` — the
 * same outward primitive every profile uses; the old bespoke `deliver` is gone.
 *
 * The job has the real host tools (`bash`, `file_read`, `file_write`, `file_edit`) so a
 * backgrounded task can actually DO work — build/edit files, run CLIs (devbox, curl), read a
 * skill's SKILL.md and follow it. No
 * `send_message`/`schedule`/`start_job` (no mid-run chatter, no nested jobs, no self-scheduling):
 * the agent's final text IS the deliverable, emitted terminally (`recoverOnMiss: 'rawtext'`).
 * Since unify-background-work (2026-07-05) this engine serves SCHEDULED runs only —
 * conversation-promoted work runs as a delegated subagent (mediated report), never a job.
 */
/** Default model for a background job; overridable per run (D-DS9, configurable model). */
const DEFAULT_JOB_MODEL = 'claude-opus-4-8';

export interface JobInput {
  threadId: string;
  task: string;
  ownerName: string;
  /** Whom the job acts for and reports to (run-audiences D-RA4); defaults to the owner. A job
   *  promoted from a family member's thread frames + addresses that person, not the owner. */
  subjectName?: string;
  /** Model id for this run (D-DS9); defaults to the standard job model. */
  model?: string;
}

export async function runJob(input: JobInput): Promise<void> {
  'use workflow';

  const setup = await buildSetup(input.model ?? DEFAULT_JOB_MODEL, input.subjectName);

  const { result } = await streamAgent({
    // `observe` gives the job exactly-once generation spans in Langfuse (session = the
    // thread the job delivers to).
    model: buildTurnModel(setup.modelId, setup.testModelResponses, {
      functionId: 'background-job',
      sessionId: input.threadId,
    }),
    instructions: setup.instructions,
    tools: {
      bash: tool({ ...BASH_TOOL_SPECS.bash, execute: (args) => bashStep(args) }),
      file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (args) => fileReadStep(args) }),
      file_write: tool({ ...FILE_TOOL_SPECS.file_write, execute: (args) => fileWriteStep(args) }),
      file_edit: tool({ ...FILE_TOOL_SPECS.file_edit, execute: (args) => fileEditStep(args) }),
    },
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
    messages: [{ role: 'user', content: input.task }],
  });

  // The final assistant text is the deliverable, delivered terminally through the one bus
  // (run-audiences D-RA15) to the job's thread — bound → gateway; a `subagent:` thread → append+wake.
  const text = finalAssistantText(result.messages);
  const message = text || 'I finished that background task but came up empty — mind rephrasing?';
  await deliver({ kind: 'thread', threadId: input.threadId }, message);
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
async function buildSetup(modelId: string, subject?: string): Promise<JobSetup> {
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
    instructions: buildJobPrompt(config, core, skillsIndex, { hostTools: true, subject }),
    modelId,
    testModelResponses: testModelResponses(),
  };
}
