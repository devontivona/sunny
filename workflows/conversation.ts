import type {
  LanguageModelUsage,
  ModelCallStreamPart,
  ModelMessage,
  SystemModelMessage,
} from '../src/agent/aiTypes.js';
import { tool } from '@ai-sdk/provider-utils';
import type { SharedV4ProviderOptions } from '@ai-sdk/provider';
import { WorkflowAgent } from '@ai-sdk/workflow';
import type { MockResponseDescriptor } from '../src/agent/mockModel.js';
import { getWritable } from 'workflow';
import { buildTurnModel } from '../src/agent/turnModel.js';
import { z } from 'zod';
import {
  BASH_TOOL_SPECS,
  type BashToolInput,
  type FileReadToolInput,
} from '../src/agent/tools/bashSpecs.js';
import { MEMORY_TOOL_SPECS } from '../src/agent/tools/memorySpecs.js';
import { SEND_MESSAGE_SPEC, STAY_SILENT_SPEC } from '../src/agent/tools/sendMessageSpec.js';
import { DELEGATE_TASK_SPEC, MESSAGE_SUBAGENT_SPEC } from '../src/agent/tools/delegationSpecs.js';
import {
  assistantUIMessageFromResponse,
  buildTurnRecord,
  calledStaySilent,
  classifyDelivery,
  extractScratch,
  extractSends,
  sendMessagePart,
  steerMessageText,
  usageOf,
  type Delivery,
} from '../src/agent/delivery.js';
import { AGENT_STEP_LIMIT } from '../src/agent/limits.js';

/**
 * Tier-1 durable conversational turn (durable-main-loop). ONE run = ONE turn (design D1,
 * revised from keep-alive after live debugging): each turn is its own durable WDK run, so it
 * streams + completes exactly like a Tier-2 job and reuses the same dashboard live-pane path.
 * The gateway (`DurableTurnRouter`) provides per-thread serialization + starts a fresh run
 * for the next turn (replacing the keep-alive hook, which caused the turns-2+ parking bug and
 * didn't map onto the per-run live pane). Gated behind `SUNNY_DURABLE_TURNS=1`.
 *
 * Correctness model (the store is the source of truth):
 * - The gateway persists every inbound on arrival (dedup), then ensures a turn-run is
 *   processing the thread; it re-checks for unanswered inbound after each run and starts the
 *   next turn-run, so a thread's turns are strictly serialized.
 * - This run reads the recent window, replies, and marks exactly the user messages it
 *   answered (the window + any steers folded mid-turn) via `processedAt`. If there's nothing
 *   unanswered (e.g. a steer already folded by the prior turn), it is a no-op.
 * - Mid-turn steering (R12): `prepareStep` reads newly-arrived messages from the store in a
 *   `'use step'` (`loadSteers`) and folds them into this turn's next model step — no second
 *   stream consumer, deterministic on replay. Every side effect (send, recovery, persist,
 *   mark) is a `'use step'`, so a crash resumes from the last step and never re-sends (D2).
 */
export interface ConversationInput {
  threadId: string;
}

interface TurnSetup {
  instructions: SystemModelMessage;
  modelId: string;
  providerOptions: SharedV4ProviderOptions;
  deliveryMode: 'tool' | 'text';
  ownerName: string;
  /** Mock model responses set by a workflow test (plain serializable data), read in the step
   *  and used by the body to build a mock; undefined in production. */
  testModelResponses?: MockResponseDescriptor[];
}

interface PendingTurn {
  messages: ModelMessage[];
  windowUserIds: string[];
  hasUnanswered: boolean;
}

export async function runConversation(input: ConversationInput): Promise<void> {
  'use workflow';

  const { threadId } = input;
  // Group threads are `…:<from>:g:<group>`; a DM is the owner's thread (auth admits only the
  // owner on DMs), so ownerDm ⇔ not-a-group — derived from the id alone (no extra input).
  const isGroup = threadId.split(':')[2] === 'g';
  const ownerDm = !isGroup;

  const setup = await setupTurn(ownerDm, threadId);
  const ownerName = setup.ownerName;

  const pending = await loadPending(threadId, isGroup);
  if (!pending.hasUnanswered || pending.messages.length === 0) return; // nothing to answer

  // Captured from the durable stream's completion (deterministic on replay).
  let finish: { totalUsage: LanguageModelUsage } | undefined;

  const agent = new WorkflowAgent({
    model: buildTurnModel(setup.modelId, setup.testModelResponses),
    instructions: setup.instructions,
    tools: buildTools({ threadId, ownerName, ownerDm }),
    providerOptions: setup.providerOptions,
    onEnd: (e) => {
      finish = { totalUsage: e.totalUsage };
    },
  });

  // Ids the model has already seen this turn — the window the prompt was built from, plus
  // any steers folded so far — so `loadSteers` only returns genuinely new mid-turn arrivals.
  const foldedIds: string[] = [];

  // WorkflowAgent writes raw model-call parts to the durable run stream; the dashboard reader
  // converts them to UIMessageChunk via `createModelCallToUIChunkTransform()` (design 3.1 — the
  // transform can't run in the workflow sandbox, so it lives at the reader boundary). v7 dropped
  // `collectUIMessages`, so the persisted turn is rebuilt from this turn's GENERATED messages below
  // (see the `finalizeTurn` call — `result.steps[].content`, never the full `result.messages`).
  const result = await agent.stream({
    messages: pending.messages,
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: ({ steps }) => steps.length >= AGENT_STEP_LIMIT,
    // Durable AI-SDK telemetry is INTENTIONALLY OFF (not silently failing). v7 emits agent spans
    // from the agent loop, which the WDK runs in an isolated `node:vm` realm that the global
    // `registerTelemetry` integration can't reach — so any `isEnabled: true` here produces ZERO
    // spans, just looking enabled. We disable it explicitly until the upstream gap is fixed
    // (vercel/ai #12164) or we adopt the event-forwarding bridge (proven, shelved — see the
    // migrate-ai-sdk-v7-workflow-agent change notes / git branch worktree-agent-af47988b13eeb3162).
    // Main-process telemetry (recovery `generateText`, etc.) is unaffected and still emits.
    telemetry: { isEnabled: false },
    // Double-text steering (R12): before each model step (after the first — the window was
    // just read, so nothing new can have arrived yet), fold any message that landed mid-turn
    // into the next step. Reads the store in a step (deterministic on replay); excludes
    // already-seen/already-folded ids.
    prepareStep: async ({ stepNumber, messages }) => {
      if (stepNumber === 0) return {};
      const steers = await loadSteers(threadId, [...pending.windowUserIds, ...foldedIds]);
      if (steers.length === 0) return {};
      for (const s of steers) foldedIds.push(s.messageId);
      return {
        messages: [
          ...messages,
          ...steers.map((s) => ({
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: steerMessageText(s.text, s.senderName, isGroup) },
            ],
          })),
        ],
      };
    },
  });

  await finalizeTurn({
    threadId,
    ownerName,
    setup,
    // ONLY the messages generated by THIS turn. `result.messages` is the FULL conversation
    // (input window + generated + folded steers), so feeding it to `assistantUIMessageFromResponse`
    // re-merges every prior assistant turn already in the window into the new row — which compounds
    // each turn and reintroduces earlier `tool_use` ids. Anthropic then rejects the whole prompt
    // ("`tool_use` ids must be unique") on every later turn, poisoning the thread into an infinite
    // retry storm. We rebuild generated-only from `result.steps[].content` (each step's freshly
    // generated text + tool-call parts — no input), paired with the run's `tool`-role messages so
    // each tool part keeps its real output. (WorkflowAgent leaves `step.response.messages`/
    // `step.toolResults` as empty stubs — see @ai-sdk/workflow dist — so those can't be used.)
    messages: [
      ...result.steps.map((s) => ({ role: 'assistant', content: s.content }) as ModelMessage),
      ...result.messages.filter((m) => m.role === 'tool'),
    ],
    steps: result.steps.length,
    usage: finish?.totalUsage,
    priorMessages: pending.messages,
  });
  // Mark the window AND every steer folded this turn, so a folded message isn't re-answered
  // as a redundant next turn-run.
  await markAnswered(threadId, [...pending.windowUserIds, ...foldedIds]);
}

/** Classify delivery, run the recovery backstop on a miss, and persist one row per turn
 *  (D-MG8 / D-MG9). Mirrors the in-process loop; every side effect is a durable step. */
async function finalizeTurn(args: {
  threadId: string;
  ownerName: string;
  setup: TurnSetup;
  /** The agent's response messages (D-MG9: rebuilds the turn's assistant UIMessage in v7). */
  messages: ModelMessage[];
  steps: number;
  usage: LanguageModelUsage | undefined;
  priorMessages: ModelMessage[];
}): Promise<void> {
  const { threadId, ownerName, setup, priorMessages } = args;
  const assistant = assistantUIMessageFromResponse(args.messages);
  if (!assistant) return;

  // Drop private `reasoning` (extended-thinking) parts before persisting (D-MG8): they are
  // never delivered, must not be re-sent as history (Anthropic rejects it — see
  // `stripReasoning` in turn.ts), and shouldn't be stored or shown on the dashboard. Keeps
  // the durable turn record consistent with the in-process loop's.
  let parts = assistant.parts.filter((p) => p.type !== 'reasoning') as typeof assistant.parts;
  const scratch = extractScratch(parts);
  let delivered: Delivery = classifyDelivery(
    extractSends(parts).length,
    scratch,
    calledStaySilent(parts),
  );
  let recovered = false;

  if (delivered === 'fallback_text') {
    // Elicitation miss (D-MG8): the model wrote text but called neither send_message nor
    // stay_silent. The miss took the backstop path, so mark it recovered regardless of the
    // pass's outcome (the dashboard [R] / Activity "Backstop" signal).
    recovered = true;
    const recoveryText = await recoverDelivery(threadId, ownerName, priorMessages, scratch);
    if (recoveryText) {
      await sendStep(threadId, recoveryText);
      parts = [...parts, sendMessagePart(recoveryText, 'recovery-0')];
      delivered = 'send_message';
    }
  }

  const projection = [scratch, ...extractSends(parts)].filter(Boolean).join('\n');
  if (parts.length > 0) {
    const usage = args.usage
      ? usageOf(args.usage)
      : { in: null, out: null, cached: null, cacheWrite: null };
    const record = buildTurnRecord(assistant, parts, {
      model: setup.modelId,
      usage,
      delivered,
      recovered,
      steps: args.steps,
    });
    await appendTurnStep(threadId, record, projection);
  }
}

/** Tools for a durable conversational turn (D6). The host tools are owner-DM-only, matching
 *  the in-process loop's `ownerDm` gating; every side-effecting `execute` is a `'use step'`
 *  so a replay never re-applies it (and `send_message` never re-sends). */
function buildTools(ctx: { threadId: string; ownerName: string; ownerDm: boolean }) {
  const { threadId, ownerName, ownerDm } = ctx;
  return {
    send_message: tool({
      ...SEND_MESSAGE_SPEC,
      execute: ({ text, image }) => sendStep(threadId, text, image),
    }),
    stay_silent: tool({
      ...STAY_SILENT_SPEC,
      // No side effect — the choice of silence is read back from the turn's parts.
      execute: async () => 'ok: staying silent',
    }),
    start_job: tool({
      description:
        'Promote a long-running or asynchronous task to a durable background job. Use this ' +
        "for work that takes a while (research, building something, multi-step tasks you can't " +
        'finish in one quick reply). The job runs to completion even across restarts and ' +
        'messages the user with the result when done. Tell the user you are on it (via ' +
        'send_message) first, then call this.',
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            'A complete, self-contained description of the task to perform in the background.',
          ),
      }),
      execute: ({ task }) => startJobStep(threadId, task, ownerName),
    }),
    memory_write: tool({
      ...MEMORY_TOOL_SPECS.memory_write,
      execute: (args) => memWriteStep(args),
    }),
    read_topic: tool({
      ...MEMORY_TOOL_SPECS.read_topic,
      execute: ({ name }) => readTopicStep(name),
    }),
    recall_history: tool({
      ...MEMORY_TOOL_SPECS.recall_history,
      execute: ({ query, limit }) => recallStep(query, limit),
    }),
    // Delegation (durable-subagents): spawn an isolated child that reports back, and steer one
    // that is still working. Non-blocking — a child's report arrives as a later inbound the
    // router folds into a fresh turn (D-DS2/3/4). Owner DMs only (delegation acts with host reach).
    ...(ownerDm
      ? {
          delegate_task: tool({
            ...DELEGATE_TASK_SPEC,
            execute: ({ task, label, toolset }) => delegateStep(threadId, { task, label, toolset }),
          }),
          message_subagent: tool({
            ...MESSAGE_SUBAGENT_SPEC,
            execute: ({ child, text }) => steerChildStep(child, text),
          }),
        }
      : {}),
    // Host tools: owner DMs only — real host access (D-TA2), mirroring the in-process loop.
    ...(ownerDm
      ? {
          bash: tool({ ...BASH_TOOL_SPECS.bash, execute: (a) => bashStep(a) }),
          file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (a) => fileReadStep(a) }),
        }
      : {}),
  };
}

// --- durable steps (run in real Node; dynamic-import runtime modules like the Tier-2
//     workflows do, so the sandboxed orchestration above stays Node-free) -------------

/**
 * Build the turn's instructions + model config once, in a step, so the byte-stable cached
 * prefix (D-PS4) stays consistent across replays. Uses the SHARED assembler so the durable
 * path's system prefix is byte-identical to the in-process loop's — `DurableAgent` honors
 * `cacheControl` on the `SystemModelMessage`, so prompt-cache behavior is preserved (5.6).
 */
async function setupTurn(ownerDm: boolean, threadId: string): Promise<TurnSetup> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { assembleTurnInstructions } = await import('../src/agent/instructions.js');
  const { anthropicProviderOptions } = await import('../src/agent/model.js');
  const { testModelResponses } = await import('../src/agent/turnModel.js');
  const { config } = await getRuntime();
  const deliveryMode = config.deliveryMode;
  void ownerDm; // tool gating happens in buildTools; kept for parity/readability
  return {
    instructions: assembleTurnInstructions(config, deliveryMode),
    modelId: config.modelId,
    providerOptions: anthropicProviderOptions(config),
    deliveryMode,
    ownerName: config.owner.name,
    // Read here (in the step, where a test's globalThis override is visible) and threaded to
    // the body to build a mock; undefined in production. Keyed per-thread (persists until the
    // route clears it), so a scripted reply reliably drives this thread's turns and never leaks
    // onto a real thread. Journaled by this step, so replays reuse it.
    testModelResponses: testModelResponses(threadId),
  };
}

/**
 * Read the thread's recent window as model messages (D-MG9), plus the window's user-message
 * ids and whether any inbound is still unanswered (the idempotency gate). Reads media from
 * disk, so it must be a step.
 */
async function loadPending(threadId: string, isGroup: boolean): Promise<PendingTurn> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { toModelMessages, trimTrailingNonUser } = await import('../src/agent/turn.js');
  const { store } = await getRuntime();
  const window = await store.recentWindow(threadId);
  const messages = trimTrailingNonUser(await toModelMessages(window, isGroup));
  const [windowUserIds, hasUnanswered] = await Promise.all([
    store.windowUserIds(threadId),
    store.hasUnansweredInbound(threadId),
  ]);
  return { messages, windowUserIds, hasUnanswered };
}

/** Read messages that arrived mid-turn (unanswered, excluding ids already seen/folded) so
 *  `prepareStep` can fold them into the in-flight turn (durable-main-loop, double-text
 *  steering). A step, so it's deterministic on replay; reads the durable store. */
async function loadSteers(
  threadId: string,
  excludeIds: string[],
): Promise<{ messageId: string; text: string; senderName?: string }[]> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { store } = await getRuntime();
  return store.unansweredSteers(threadId, excludeIds);
}

/** Deliver a message by threadId (REST send via the gateway; D2). Memoized as a step so a
 *  replayed turn does NOT re-send. Returns the media outcome for the persisted turn. */
async function sendStep(
  threadId: string,
  text: string,
  image?: string,
): Promise<{ status: string; media?: unknown } | string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { gateway } = await getRuntime();
  const result = await gateway.send(
    threadId,
    { text, ...(image ? { attachment: { pathOrUrl: image } } : {}) },
    { persist: false },
  );
  return result?.media ? { status: 'delivered', media: result.media } : 'delivered';
}

/** Delivery-recovery backstop (D-MG8) as a step: a cheap model rewrites the private notes
 *  into a clean iMessage. Returns '' if there is nothing to compose. */
async function recoverDelivery(
  threadId: string,
  ownerName: string,
  messages: ModelMessage[],
  scratch: string,
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { getRecoveryModel } = await import('../src/agent/model.js');
  const { runRecoveryPass } = await import('../src/agent/recovery.js');
  const { config } = await getRuntime();
  try {
    return await runRecoveryPass({
      model: getRecoveryModel(config),
      ownerName,
      messages,
      scratch,
      threadId,
    });
  } catch {
    return '';
  }
}

/** Persist one enriched UIMessage row for the turn (D-MG9). */
async function appendTurnStep(
  threadId: string,
  payload: unknown,
  projection: string,
): Promise<void> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { store } = await getRuntime();
  await store.appendTurn(threadId, payload, projection);
}

/** Mark exactly the user messages this turn answered as processed (the watermark). */
async function markAnswered(threadId: string, messageIds: string[]): Promise<void> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { store } = await getRuntime();
  // Scope by threadId (not a hardcoded channel) so non-iMessage threads (e.g. the loopback test
  // channel) get marked too — otherwise `hasUnansweredInbound` stays true and the turn re-runs forever.
  await store.markAnsweredForThread(threadId, messageIds);
}

async function startJobStep(threadId: string, task: string, ownerName: string): Promise<string> {
  'use step';

  const { start } = await import('workflow/api');
  const { runJob } = await import('./job.js');
  const run = await start(runJob, [{ threadId, task, ownerName }]);
  return `Started durable background job ${run.runId}; it will message the user on completion.`;
}

/**
 * Delegate a subtask to an isolated child (durable-subagents D-DS2): hand the brief to the
 * in-process supervisor (via the runtime seam — a step can't reach it directly, task 3.3), which
 * enforces the caps, starts the child, links it, and arms the watchdog. Returns the child's id
 * immediately (non-blocking); the child reports back as a later inbound on THIS thread. Top-level
 * Sunny delegations are depth 1 and non-orchestrator (no sub-delegation, D-DS8).
 */
async function delegateStep(
  parentThreadId: string,
  args: { task: string; label?: string; toolset?: 'host' | 'readonly' | 'memory' | 'none' },
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const rt = await getRuntime();
  if (!rt.spawnChild) return 'Delegation is unavailable in this runtime.';
  const res = await rt.spawnChild({
    parentThreadId,
    task: args.task,
    label: args.label,
    toolset: args.toolset,
    depth: 1,
    orchestrator: false,
  });
  if ('error' in res) {
    return res.error === 'depth_cap'
      ? 'Delegation refused: max delegation depth reached.'
      : 'Delegation refused: already at the concurrent-subagent limit (3). Wait for one to finish.';
  }
  return (
    `Delegated to subagent "${args.label ?? 'subagent'}" (id ${res.childThreadId}). It is working ` +
    `in its own context and will report back here when done; you can keep going or steer it with ` +
    `message_subagent.`
  );
}

/** Steer a still-working child (durable-subagents D-DS4): append to its inbox; its in-flight run
 *  folds the message via `loadSteers`. A no-op if the child already finished (run-to-completion). */
async function steerChildStep(childThreadId: string, text: string): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const rt = await getRuntime();
  if (!rt.steerChild) return 'Subagent steering is unavailable in this runtime.';
  await rt.steerChild(childThreadId, text);
  return `Sent to subagent ${childThreadId}; it will fold your message into its work.`;
}

async function memWriteStep(args: {
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
