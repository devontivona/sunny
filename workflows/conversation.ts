import type { LanguageModelUsage, ModelMessage, SystemModelMessage } from '../src/agent/aiTypes.js';
import { tool } from '@ai-sdk/provider-utils';
import type { SharedV4ProviderOptions } from '@ai-sdk/provider';
import type { MockResponseDescriptor } from '../src/agent/mockModel.js';
import { buildTurnModel } from '../src/agent/turnModel.js';
import { z } from 'zod';
import { BASH_TOOL_SPECS } from '../src/agent/tools/bashSpecs.js';
import { FILE_TOOL_SPECS } from '../src/agent/tools/fileSpecs.js';
import { MEMORY_TOOL_SPECS } from '../src/agent/tools/memorySpecs.js';
import { SEND_IMAGE_SPEC } from '../src/agent/tools/sendImageSpec.js';
import { MESSAGE_SPEC } from '../src/agent/tools/messageSpec.js';
import { RUNS_TOOL_SPECS, scheduleToolSpecs } from '../src/agent/tools/scheduleSpecs.js';
import {
  CREDENTIAL_MANAGE_SPEC,
  type CredentialManageInput,
} from '../src/agent/tools/credentialManageSpecs.js';
import { DELEGATE_TASK_SPEC, type ChildModelName } from '../src/agent/tools/delegationSpecs.js';
import { TRUSTED_DM_AUTHORITY } from '../src/agent/audience.js';
import type { ChildToolset } from './subagent.js';
import { isGroupThreadId } from '../src/gateway/threadId.js';
import {
  assistantUIMessageFromResponse,
  buildTurnRecord,
  classifyTextDelivery,
  extractFinalText,
  extractInterimText,
  stripNoReply,
  translatorPart,
  usageOf,
  type Delivery,
} from '../src/agent/delivery.js';
import { bashStep, fileEditStep, fileReadStep, fileWriteStep, streamAgent } from './runShell.js';

/**
 * Tier-1 durable conversational turn (durable-main-loop). ONE run = ONE turn (design D1,
 * revised from keep-alive after live debugging): each turn is its own durable WDK run, so it
 * streams + completes exactly like a Tier-2 job and reuses the same dashboard live-pane path.
 * The gateway (`DurableTurnRouter`) provides per-thread serialization + starts a fresh run
 * for the next turn (replacing the keep-alive hook, which caused the turns-2+ parking bug and
 * didn't map onto the per-run live pane).
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
  /** Progress-translator cadence (config.translatorEveryNSteps). Journaled here so
   *  the body never reads config. */
  translatorEveryNSteps: number;
  ownerName: string;
  /** The owner's configured timezone — used for `schedule_create` cron/timestamp evaluation
   *  and interpolated into the tool description (run-audiences Phase 1a). */
  timezone: string;
  /** Whether the owner is a participant of this thread — gates the owner-only USER.md carve-out
   *  (multiplayer-family D2/D3). False in a family-only DM/group. */
  ownerPresent: boolean;
  /** Whom a job promoted from this thread acts for (run-audiences D-RA4): the sole family
   *  participant when the owner is absent, else undefined (→ the job frames for the owner). */
  subjectName?: string;
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
  // A DM admits only TRUSTED senders (owner or family, per gateway auth), so a DM ⇒ the elevated
  // toolset — derived from the id alone via `isGroupThreadId`. The owner-only carve-out (editing
  // USER.md) is gated separately on whether the owner is actually present (setup.ownerPresent).
  const isGroup = isGroupThreadId(threadId);
  const trustedDm = !isGroup;

  const setup = await setupTurn(threadId, isGroup);
  const ownerName = setup.ownerName;

  const pending = await loadPending(threadId, isGroup);
  if (!pending.hasUnanswered || pending.messages.length === 0) return; // nothing to answer

  // The conversation is a STEERABLE run (R12 double-text): `streamAgent` folds any message that
  // landed mid-turn via `loadSteers` in `prepareStep`, excluding the window the prompt was built
  // from plus steers already folded — so only genuinely new arrivals come back. The telemetry-off
  // + writable + step-limit wiring lives in `streamAgent` (shared by every profile). `foldedIds`
  // (the steers this turn absorbed) and `usage` come back so we can mark + record exactly them.
  // In text mode a translator relays interim progress on the cadence steps (Phase 3): compose
  // (`translateStep`) and send are SEPARATE memoized steps, so a replay never re-relays.
  const subject = setup.subjectName ?? ownerName;
  const { result, usage, foldedIds, translatorUpdates } = await streamAgent({
    model: buildTurnModel(setup.modelId, setup.testModelResponses),
    instructions: setup.instructions,
    tools: buildTools({
      threadId,
      ownerName,
      trustedDm,
      ownerPresent: setup.ownerPresent,
      timezone: setup.timezone,
      subjectName: setup.subjectName,
    }),
    providerOptions: setup.providerOptions,
    messages: pending.messages,
    steering: {
      inboxThreadId: threadId,
      isGroup,
      baseExcludeIds: pending.windowUserIds,
    },
    translator: {
      everyNSteps: setup.translatorEveryNSteps,
      compose: (interim, recentUpdates, stepNumber, stepsSinceUpdate) =>
        translateStep(threadId, subject, interim, recentUpdates, stepNumber, stepsSinceUpdate),
      // Two journaled steps per relayed update: the real delivery, then a best-effort
      // live-pane publish (translator sends never ride the model stream, so without
      // this the dashboard's live view can't show them).
      send: async (text) => {
        await sendStep(threadId, text);
        await publishTranslatorLiveStep(threadId, text);
      },
    },
  });

  const answered = await finalizeTurn({
    threadId,
    ownerName,
    setup,
    finishReason: result.steps.at(-1)?.finishReason,
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
    usage,
    priorMessages: pending.messages,
    translatorUpdates,
  });
  // Only mark answered when the turn actually produced a deliverable outcome (a reply, a
  // delivered backstop, deliberate silence, or tool work). A turn that delivered nothing
  // (no assistant output, or a failed backstop; R9b/R9c) leaves the inbound unanswered so the
  // router re-runs it, rather than silently consuming it with no reply.
  if (answered) {
    // Mark the window AND every steer folded this turn, so a folded message isn't re-answered
    // as a redundant next turn-run.
    await markAnswered(threadId, [...pending.windowUserIds, ...foldedIds]);
  } else {
    await noteUnanswered(threadId);
  }
}

/** Deliver the turn's reply and persist one row per turn (text-as-reply, PR #31; D-MG9).
 *  The FINAL text (after the last tool call) IS the reply, delivered here as blank-line
 *  bubbles via the memoized send step; a bare `<no-reply/>` sentinel is deliberate silence;
 *  interim narration is the translator's source material; an empty final with narration is
 *  an ABNORMAL turn end (step limit / length / error finish) that the backstop composes a
 *  status message from. Relayed translator updates persist as `data-translator` parts.
 *  Every side effect is a durable step. */
async function finalizeTurn(args: {
  threadId: string;
  ownerName: string;
  setup: TurnSetup;
  /** The agent's response messages (D-MG9: rebuilds the turn's assistant UIMessage in v7). */
  messages: ModelMessage[];
  steps: number;
  usage: LanguageModelUsage | undefined;
  priorMessages: ModelMessage[];
  /** The last step's finish reason (`result.finishReason`) — distinguishes a deliberate stop
   *  from an abnormal end (step-limit/length/error) when nothing was delivered (R9a). */
  finishReason?: string;
  /** The progress updates the translator relayed this turn (text mode; already delivered). */
  translatorUpdates: { text: string; step: number }[];
}): Promise<boolean> {
  const { threadId, ownerName, setup, priorMessages } = args;
  // Relayed translator updates persist at their TRUE chronological position: an update
  // triggered at step N was texted before step N generated, so its `data-translator` part
  // is inserted before that step's parts (2026-07-05: the old post-hoc "after the last
  // tool call" placement rendered updates out of order in the dashboard trajectory).
  const inserted = new Set<number>();
  const assistant = assistantUIMessageFromResponse(args.messages, (stepIndex) => {
    const ups = args.translatorUpdates.filter((u) => u.step === stepIndex);
    if (ups.length > 0) inserted.add(stepIndex);
    return ups.map((u) => translatorPart(u.text, u.step));
  });
  // No assistant message at all (R9c): the turn produced nothing to deliver, persist, or
  // classify. Report "not answered" so the caller does NOT mark the inbound processed — leaving
  // it for a re-run rather than silently consuming it with no reply.
  if (!assistant) return false;

  // Drop private `reasoning` (extended-thinking) parts before persisting (D-MG8): they are
  // never delivered, must not be re-sent as history (Anthropic rejects it — see
  // `stripReasoning` in turn.ts), and shouldn't be stored or shown on the dashboard. Keeps
  // the durable turn record consistent with the in-process loop's.
  let parts = assistant.parts.filter((p) => p.type !== 'reasoning') as typeof assistant.parts;
  // Frame backstop/relayed messages for the thread's subject (D-RA4/F6) — a family member
  // when the owner is absent — not hardcoded to the owner.
  const subject = setup.subjectName ?? ownerName;
  let recovered = false;

  const interim = extractInterimText(parts);
  // Silence is the <no-reply/> sentinel reply, parsed out here; the raw text (sentinel
  // included) still persists in the row, so history carries the exact silence precedent.
  const parsed = stripNoReply(extractFinalText(parts));
  let finalText = parsed.text;
  let delivered: Delivery = classifyTextDelivery(
    finalText,
    interim,
    parsed.sentinel,
    args.finishReason,
  );
  // Whether the user actually received something this turn (a reply, or a delivered backstop).
  let sent = false;
  // Whether the backstop was attempted but produced nothing — a fallback miss that must NOT be
  // silently marked answered (R9b).
  let backstopFailed = false;

  if (delivered === 'text') {
    // One message per reply (2026-07-05: bubble-splitting on blank lines was too noisy —
    // a multi-paragraph reply arrives as a single text).
    await sendStep(threadId, finalText);
    sent = true;
  } else if (delivered === 'fallback_text') {
    // Abnormal turn end: the turn narrated work but never wrote the reply (step limit,
    // length cap, or an error finish — a deliberate turn always ends on reply text or the
    // silence sentinel). The backstop composes an honest status from the narration ('said'
    // labeling — prior turns' text WAS delivered speech). Marked recovered regardless of
    // outcome (the dashboard [R] / Activity "Backstop" signal).
    recovered = true;
    const recoveryText = await recoverDelivery(threadId, subject, priorMessages, interim);
    if (recoveryText) {
      await sendStep(threadId, recoveryText);
      // Recorded as a PLAIN TEXT part — never a synthetic tool part (tool_use id hygiene).
      // Replayed as history it reads as the turn's final reply text, so the persisted
      // precedent reinforces the correct shape (the PR #30 self-reinforcement argument).
      parts = [...parts, { type: 'text', text: recoveryText } as (typeof parts)[number]];
      finalText = recoveryText;
      delivered = 'text';
      sent = true;
    } else {
      backstopFailed = true;
    }
  }

  // Safety net: an update whose trigger step never generated (a run cut off mid-step)
  // has no insertion point above — append it so the record never drops a delivered text.
  const leftovers = args.translatorUpdates.filter((u) => !inserted.has(u.step));
  if (leftovers.length > 0) {
    parts = [...parts, ...leftovers.map((u) => translatorPart(u.text, u.step))] as typeof parts;
  }

  const projection = [interim, ...args.translatorUpdates.map((u) => u.text), finalText]
    .filter(Boolean)
    .join('\n');

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

  // Whether the inbound is safely answered (→ the caller marks it processed). A turn that
  // delivered nothing must NOT be silently consumed (R9b/R9c): it stays unanswered for a re-run.
  //  - sent (a reply or a delivered backstop) → answered.
  //  - deliberate silence (the <no-reply/> sentinel) → answered (a real decision was made).
  //  - a failed backstop → NOT answered, even if the turn did tool work (no reply reached the user).
  //  - tool activity but no text/sentinel (e.g. an image sent via a tool) → answered (work landed).
  //  - nothing deliverable at all → NOT answered.
  if (sent || parsed.sentinel) return true;
  if (backstopFailed) return false;
  if (parts.some((p) => p.type.startsWith('tool-'))) return true;
  return false;
}

/** Tools for a durable conversational turn (D6). The host/delegation tools are trusted-DM-only
 *  (owner OR family — gateway auth admits only trusted senders to a DM; multiplayer-family D2);
 *  groups stay tool-limited regardless of trust (design D5). Editing the owner-only core files
 *  (USER.md, SUNNY.md) is gated on `ownerPresent`. Every side-effecting `execute` is a `'use step'`
 *  so a replay never re-applies it (and a delivered bubble never re-sends). */
function buildTools(ctx: {
  threadId: string;
  ownerName: string;
  trustedDm: boolean;
  ownerPresent: boolean;
  timezone: string;
  subjectName?: string;
}) {
  const { threadId, ownerName, trustedDm, ownerPresent, timezone, subjectName } = ctx;
  const scheduleSpecs = scheduleToolSpecs(timezone);
  return {
    // The reply IS the final text (delivered in finalizeTurn); silence is the <no-reply/>
    // sentinel reply (no tool — silence-by-text goes WITH the trained end-with-text prior;
    // see NO_REPLY_SENTINEL). send_image is the one outbound-media verb.
    send_image: tool({
      ...SEND_IMAGE_SPEC,
      execute: ({ pathOrUrl, caption }) => sendStep(threadId, caption ?? '', pathOrUrl),
    }),
    memory_write: tool({
      ...MEMORY_TOOL_SPECS.memory_write,
      execute: (args) => memWriteStep({ ...args, ownerPresent }),
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
    // router folds into a fresh turn (D-DS2/3/4). Trusted DMs only (delegation acts with host reach).
    ...(trustedDm
      ? {
          delegate_task: tool({
            ...DELEGATE_TASK_SPEC,
            execute: ({ task, label, toolset, model }) =>
              delegateStep(threadId, { task, label, toolset, model }),
          }),
          // One addressed messaging verb over the delivery bus (D-RA15): reach a roster person
          // (relay → their bound DM) OR steer one of your running subagents (→ its detached
          // inbox). Unifies the former message_person + message_subagent. Trusted DMs only.
          message: tool({
            ...MESSAGE_SPEC,
            execute: ({ recipient, text, image }) => messageStep(threadId, recipient, text, image),
          }),
          // Self-scheduling (scheduling D-SC3; run-audiences Phase 1a). Trusted DMs only (owner
          // OR family — the durable-main-loop migration dropped these entirely, the regression
          // this restores). A fired schedule delivers back to THIS thread by default. Scheduled
          // runs never get these tools (anti-recursion, D-SC4). Each execute is a `'use step'`
          // so a replay never double-inserts / double-deletes.
          schedule_create: tool({
            ...scheduleSpecs.schedule_create,
            execute: (args) => scheduleCreateStep(threadId, args),
          }),
          // Unified run lifecycle (run-audiences Phase 3.2): inspect + cancel schedules AND
          // this conversation's running subagents, ownership-scoped (owner sees all; a family
          // member only their own). Replaces schedule_list / schedule_delete.
          list_runs: tool({
            ...RUNS_TOOL_SPECS.list_runs,
            execute: () => listRunsStep(threadId, ownerPresent, subjectName ?? ownerName),
          }),
          cancel_run: tool({
            ...RUNS_TOOL_SPECS.cancel_run,
            execute: ({ id }) =>
              cancelRunStep(id, threadId, ownerPresent, subjectName ?? ownerName),
          }),
        }
      : {}),
    // Credential registry (credentials D-CR5) — owner-DM only (credentials are owner-facing,
    // stricter than the trusted-DM gate: family must not enumerate the vault or rewire
    // name→reference mappings). The in-process loop registered this on owner DMs; the
    // durable-main-loop migration dropped it (2026-07-06 regression: Sunny couldn't
    // discover/register vault items even though bash `credentials` injection — which
    // resolves the names this tool registers — kept working). `'use step'`-wrapped like
    // every side-effecting execute, so a replay never re-registers.
    ...(trustedDm && ownerPresent
      ? {
          credential_manage: tool({
            ...CREDENTIAL_MANAGE_SPEC,
            execute: (args) => credentialManageStep(args),
          }),
        }
      : {}),
    // Host tools: trusted DMs only — real host access (D-TA2), mirroring the in-process loop.
    // file_write/file_edit ride the same gate as bash (coding-agent-upgrade): they are file
    // mutation primitives, not extra privilege — bash could already write anywhere.
    ...(trustedDm
      ? {
          bash: tool({ ...BASH_TOOL_SPECS.bash, execute: (a) => bashStep(a) }),
          file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (a) => fileReadStep(a) }),
          file_write: tool({ ...FILE_TOOL_SPECS.file_write, execute: (a) => fileWriteStep(a) }),
          file_edit: tool({ ...FILE_TOOL_SPECS.file_edit, execute: (a) => fileEditStep(a) }),
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
async function setupTurn(threadId: string, isGroup: boolean): Promise<TurnSetup> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { assembleTurnInstructions } = await import('../src/agent/instructions.js');
  const { anthropicProviderOptions } = await import('../src/agent/model.js');
  const { testModelResponses } = await import('../src/agent/turnModel.js');
  const { Authorizer } = await import('../src/gateway/auth.js');
  const { personId, ensureAndLoadPeople } = await import('../src/memory/index.js');
  const { rosterMatch } = await import('../src/agent/audience.js');
  const { config, store } = await getRuntime();

  // Resolve the thread's trusted participants from persisted history (multiplayer-family D3).
  // Owner presence comes from the persisted `isOwner` tag (also correct for the loopback test
  // channel's synthetic owner); family participants are resolved fresh from the current roster,
  // and their profile docs are auto-created on first contact and loaded into context.
  const window = await store.recentWindow(threadId);
  const authorizer = new Authorizer(config);
  const userRows = window.filter((m) => m.role === 'user');
  const ownerPresent = userRows.some((m) => m.isOwner);
  const seen = new Set<string>();
  const familyRefs: { id: string; name: string; identity: string }[] = [];
  for (const m of userRows) {
    if (m.isOwner || authorizer.resolveRole(m.senderId) !== 'family') continue;
    const id = personId(m.senderId);
    if (seen.has(id)) continue;
    seen.add(id);
    familyRefs.push({ id, name: m.senderName ?? m.senderId, identity: m.senderId });
  }
  const docs = await ensureAndLoadPeople(config, familyRefs);
  const people = docs.length > 0 ? { ownerPresent, docs } : undefined;
  void isGroup; // group-specific gating happens in buildTools / gateway auth

  return {
    instructions: assembleTurnInstructions(config, people),
    modelId: config.modelId,
    providerOptions: anthropicProviderOptions(config),
    translatorEveryNSteps: config.translatorEveryNSteps,
    ownerName: config.owner.name,
    timezone: config.timezone,
    ownerPresent,
    // A job promoted from a family-only thread acts for that family member (D-RA4); when the
    // owner is present the subject is the owner (undefined → default owner framing). Resolve to
    // the CANONICAL roster name (not the raw iMessage senderName) so it matches the subject
    // `list_runs`/`cancel_run` derive from a schedule's audience — otherwise a family member whose
    // push-name ≠ roster name can't see or cancel their own schedules.
    subjectName: ownerPresent
      ? undefined
      : familyRefs[0]
        ? (rosterMatch(familyRefs[0].identity, config) ?? familyRefs[0].name)
        : undefined,
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
  const { store, config } = await getRuntime();
  const window = await store.recentWindow(threadId);
  const messages = trimTrailingNonUser(
    await toModelMessages(window, isGroup, {
      // Read-time rendering of persisted translator updates (text-delivery Phase 3):
      // 'attributed' shows the model what the user already heard; 'excluded' strips them.
      translatorHistory: config.translatorHistory,
      translatorSubject: config.owner.name,
    }),
  );
  // Derive the mark-answered id set from the SAME window snapshot the prompt was built from
  // (R6). A second `windowUserIds` query is a separate DB read: a message inserted in the gap
  // could land in that query but NOT in the prompt window — then it would be excluded from
  // steering (in baseExcludeIds) AND stamped answered by `markAnswered`, silently dropped
  // without ever being seen. Deriving from `window` guarantees a message not in the prompt can
  // never be marked answered; a gap arrival stays unprocessed and is picked up next turn.
  const windowUserIds = window.filter((m) => m.role === 'user').map((m) => m.messageId);
  const hasUnanswered = await store.hasUnansweredInbound(threadId);
  return { messages, windowUserIds, hasUnanswered };
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

/** Abnormal-turn-end backstop as a step: when a turn ends without reply text (step limit /
 *  length / error finish), the cheap utility model composes an honest status message from
 *  the turn's working notes. Returns '' if there is nothing to compose. */
async function recoverDelivery(
  threadId: string,
  ownerName: string,
  messages: ModelMessage[],
  notes: string,
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { logger } = await import('../src/logger.js');
  const rt = (await getRuntime()) as Awaited<
    ReturnType<typeof import('../src/runtime.js').getRuntime>
  > & { recoverOverride?: (notes: string) => string };
  try {
    // Test seam (mirrors translateOverride/stubJobs): workflow tests stub the composed
    // text so the backstop path is exercised hermetically, without a live model call.
    if (rt.recoverOverride) return rt.recoverOverride(notes);
    const { getUtilityModel } = await import('../src/agent/model.js');
    const { runBackstopPass } = await import('../src/agent/recovery.js');
    return await runBackstopPass({
      model: getUtilityModel(rt.config),
      ownerName,
      messages,
      notes,
      threadId,
    });
  } catch (err) {
    // Log the swallowed failure (R9b): a silent '' here left the caller sending nothing while
    // still marking the user answered. The caller now leaves the inbound unanswered on an empty
    // result, and this trace explains why a backstop turn produced no reply.
    logger('conversation').warn('recovery backstop failed (no fallback text composed)', {
      threadId,
      err: String(err),
    });
    return '';
  }
}

/** Best-effort live-pane publish of a relayed translator update (a `data-translator`
 *  chunk onto the thread's running turn). Journaled, so a replay never re-publishes;
 *  display-only — failures never affect the turn. */
async function publishTranslatorLiveStep(threadId: string, text: string): Promise<void> {
  'use step';

  try {
    const { getLiveBus } = await import('../src/observability/live.js');
    getLiveBus().publishThreadChunk(threadId, {
      type: 'data-translator',
      data: { text },
    } as Parameters<ReturnType<typeof getLiveBus>['publishThreadChunk']>[1]);
  } catch {
    // display-only
  }
}

/**
 * Compose one interim progress update (text-delivery Phase 3) as a step: the cheap
 * utility model summarizes the turn's narration since the last update, or declines
 * ('' — silence is the translator's default). Journaled, so a replay reuses the composed
 * text; the SEND is a separate memoized step (never re-relays). Best-effort by design: a
 * translator failure must never fail the turn, so errors collapse to silence.
 * `translateOverride` on the runtime is the test seam (mirrors `stubJobs`).
 */
async function translateStep(
  threadId: string,
  subject: string,
  interim: string,
  recentUpdates: string[],
  stepNumber: number,
  stepsSinceUpdate: number,
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { logger } = await import('../src/logger.js');
  const rt = (await getRuntime()) as Awaited<
    ReturnType<typeof import('../src/runtime.js').getRuntime>
  > & {
    translateOverride?: (
      interim: string,
      recentUpdates: string[],
      stepNumber?: number,
      stepsSinceUpdate?: number,
    ) => string;
  };
  if (rt.translateOverride) {
    return rt.translateOverride(interim, recentUpdates, stepNumber, stepsSinceUpdate);
  }
  const { getUtilityModel } = await import('../src/agent/model.js');
  const { runTranslatorPass } = await import('../src/agent/translator.js');
  try {
    const update = await runTranslatorPass({
      model: getUtilityModel(rt.config),
      subject,
      interim,
      recentUpdates,
      stepNumber,
      stepsSinceUpdate,
      threadId,
    });
    // One line per decision — the 2026-07-05 investigation had to reconstruct translator
    // behavior from generic Langfuse spans because nothing here was logged.
    logger('translator').info('progress-update decision', {
      threadId,
      stepNumber,
      stepsSinceUpdate,
      sent: update.length > 0,
    });
    return update;
  } catch (err) {
    logger('translator').warn('translator pass failed (skipping update)', {
      threadId,
      stepNumber,
      err: String(err),
    });
    return '';
  }
}

/**
 * Persist one enriched UIMessage row for the turn (D-MG9). BEST-EFFORT: a persist
 * failure must NOT abort the run, because the turn has already DELIVERED (bubbles send
 * before this step) — if this threw, the run would fail before `markAnswered`, the
 * inbound would stay unanswered, and the router would re-run the turn and re-deliver
 * (the duplicate-reply bug). Losing a transcript row is a far smaller harm than
 * re-texting the user, so we log + swallow. The store also sanitizes NUL/surrogates,
 * so the historical trigger (a binary file_read in the payload) no longer fails here.
 */
async function appendTurnStep(
  threadId: string,
  payload: unknown,
  projection: string,
): Promise<void> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { logger } = await import('../src/logger.js');
  const { store } = await getRuntime();
  try {
    await store.appendTurn(threadId, payload, projection);
  } catch (err) {
    logger('conversation').error('turn persist failed (delivered; dropping transcript row)', {
      threadId,
      err: String(err),
    });
  }
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

/** Record that a turn produced no deliverable output and the inbound was left unanswered
 *  (R9b/R9c). Observability only — the message stays unprocessed so the router re-runs it. */
async function noteUnanswered(threadId: string): Promise<void> {
  'use step';

  const { logger } = await import('../src/logger.js');
  logger('conversation').warn('turn produced no deliverable output; leaving inbound unanswered', {
    threadId,
  });
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
  args: { task: string; label?: string; toolset?: ChildToolset; model?: ChildModelName },
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { resolveChildModel } = await import('../src/agent/tools/delegationSpecs.js');
  const rt = await getRuntime();
  if (!rt.spawnChild) return 'Delegation is unavailable in this runtime.';
  const res = await rt.spawnChild({
    parentThreadId,
    task: args.task,
    label: args.label,
    toolset: args.toolset,
    model: resolveChildModel(args.model),
    depth: 1,
    orchestrator: false,
    // Delegation is trusted-DM-only, so the parent holds the full authority (D-RA5); the child's
    // toolset grants are attenuated against it at spawn.
    parentAuthority: TRUSTED_DM_AUTHORITY,
  });
  if ('error' in res) {
    if (res.error === 'depth_cap') return 'Delegation refused: max delegation depth reached.';
    if (res.error === 'authority') {
      return 'Delegation refused: the requested tools exceed what this conversation is allowed.';
    }
    return 'Delegation refused: already at the concurrent-subagent limit (3). Wait for one to finish.';
  }
  return (
    `Delegated to subagent "${args.label ?? 'subagent'}" (id ${res.childThreadId}). It is working ` +
    `in its own context and will report back here when done — the task is HANDLED, so do not ` +
    `also work on it yourself. Move on (or steer it with the message tool, passing its id).`
  );
}

/** Steer a still-working child (durable-subagents D-DS4): append to its inbox; its in-flight run
 *  folds the message via `loadSteers`. A no-op if the child already finished (run-to-completion). */
/**
 * One addressed message over the delivery bus (D-RA15). Dispatches on the recipient: a subagent id
 * (a `subagent:` inbox that is a running child of THIS conversation) → steer it (detached mailbox,
 * append + wake via `loadSteers`); anything else → relay to a roster person (their bound DM via the
 * gateway). Memoized as a `'use step'` so a durable replay never double-sends. Unifies the former
 * `steerChildStep` (message_subagent) + `messagePersonStep` (message_person).
 */
async function messageStep(
  parentThreadId: string,
  recipient: string,
  text: string,
  image?: string,
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { isChildThread, getLinkByChildThread } = await import('../src/agent/delegation.js');
  const rt = await getRuntime();

  // Subagent recipient — steer one of THIS conversation's running children.
  if (isChildThread(recipient)) {
    if (!rt.steerChild) return 'Subagent steering is unavailable in this runtime.';
    const link = await getLinkByChildThread(rt.db, recipient);
    if (!link || link.parentThreadId !== parentThreadId) {
      return `No subagent ${recipient} belongs to this conversation.`;
    }
    const delivered = await rt.steerChild(recipient, text);
    return delivered
      ? `Sent to subagent ${recipient}; it will fold your message into its work.`
      : `Subagent ${recipient} has already finished, so it did not receive that. If you need ` +
          `more from it, delegate a fresh task (include the prior result in the brief).`;
  }

  // Person recipient — relay to a roster member on their own bound thread.
  return personRelayStepBody(rt, recipient, text, image);
}

/**
 * Relay body for a person recipient (multiplayer-family: cross-thread sends). Resolves the
 * recipient against the owner/family roster (ROSTER-ONLY — arbitrary numbers are refused), finds
 * their existing bound DM thread (or constructs one), and proactively sends + persists into THAT
 * thread. Runs INSIDE `messageStep`'s `'use step'`, so it takes the resolved runtime (not its own
 * step) and a durable replay never double-texts.
 */
async function personRelayStepBody(
  rt: Awaited<ReturnType<typeof import('../src/runtime.js').getRuntime>>,
  person: string,
  text: string,
  image?: string,
): Promise<string> {
  const { resolveRosterMember, resolveMemberThread } = await import('../src/agent/audience.js');
  const { config, store, gateway } = rt;

  // Resolve the recipient against the roster (owner + family) — the SINGLE shared matcher.
  const member = resolveRosterMember(person, config);
  if (!member) {
    const known = [config.owner.name, ...config.family.map((f) => f.name)].join(', ');
    return (
      `I can only text people in your family roster (right now: ${known}). ` +
      `"${person}" isn't one of them, so I didn't send anything.`
    );
  }

  // Address their existing DM if we have one; otherwise construct a Sendblue DM id (the shared
  // resolve-roster-member → find-thread → fallback tail). Null ⟺ no thread AND no from-number.
  const threadId = await resolveMemberThread(store, member.identity);
  if (!threadId) {
    return `I don't have a conversation with ${member.name} yet and can't start one right now.`;
  }

  // An optional image rides along as a single outbound attachment, exactly like send_image's
  // path; the gateway hosts/sends + persists it (degrading to text in group threads).
  await gateway.send(
    threadId,
    { text, ...(image ? { attachment: { pathOrUrl: image } } : {}) },
    { persist: true },
  );
  return image ? `Sent to ${member.name} (with image).` : `Sent to ${member.name}.`;
}

async function memWriteStep(args: {
  file: string;
  action: 'add' | 'replace' | 'remove';
  content?: string;
  target?: string;
  /** Owner-only carve-out (multiplayer-family D2): the owner-only core files (USER.md, SUNNY.md)
   *  may only be edited when the owner is present. Undefined (legacy callers) is permissive. */
  ownerPresent?: boolean;
}): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execMemoryWrite } = await import('../src/agent/tools/memory.js');
  const { config } = await getRuntime();
  // USER (the owner's profile) and SUNNY (Sunny's operating notes) are owner-only: family must not
  // rewrite the owner's model or reprogram Sunny's conduct. Family can still write people:<id>,
  // topic docs, and INDEX.
  const fileKey = args.file.trim().toUpperCase();
  if (args.ownerPresent === false && (fileKey === 'USER' || fileKey === 'SUNNY')) {
    return (
      `ERROR: editing ${fileKey}.md is restricted to the owner. ` +
      `Record durable facts about another person with file "people:<id>" instead.`
    );
  }
  const { file, action, content, target } = args;
  return execMemoryWrite(config, { file, action, content, target });
}

async function readTopicStep(name: string): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execReadTopic } = await import('../src/agent/tools/memory.js');
  const { config } = await getRuntime();
  return execReadTopic(config, name);
}

/** Credential-registry actions (list/discover/register) as a durable step. The resolver comes
 *  from env exactly like `bashStep`'s injection path, so "register" verifies against the SAME
 *  1Password client the bash `credentials` argument resolves through. Journaled — a replayed
 *  turn never re-registers. */
async function credentialManageStep(args: CredentialManageInput): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execCredentialManage } = await import('../src/agent/tools/credentialManage.js');
  const { resolverFromEnv } = await import('../src/credentials/index.js');
  const { config } = await getRuntime();
  return execCredentialManage(config, resolverFromEnv() ?? undefined, args);
}

/**
 * Self-scheduling steps (run-audiences Phase 1a). `'use step'`-wrapped so a durable replay never
 * re-inserts (create appends a row) or re-deletes. The fired schedule delivers back to
 * `threadId` — the thread where it was created — using the existing `outputTarget` model
 * (Phase 2 migrates delivery to the audience/bus). Timezone comes from config in the step.
 */
async function scheduleCreateStep(
  threadId: string,
  args: {
    kind: 'once' | 'interval' | 'cron';
    spec: string;
    prompt: string;
    label?: string;
    for?: string;
  },
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { createSchedule } = await import('../src/scheduler/index.js');
  const { rosterMatch } = await import('../src/agent/audience.js');
  const { db, config } = await getRuntime();

  // "for" schedules this on behalf of ANOTHER family member (run-audiences #4): store an explicit
  // `person:<name>` audience so the fired run acts for + delivers to them, not the creating thread.
  let audience: string | undefined;
  if (args.for) {
    const name = rosterMatch(args.for, config);
    if (!name) {
      const known = [config.owner.name, ...config.family.map((f) => f.name)].join(', ');
      return `I can only schedule for family roster members (${known}); "${args.for}" isn't one.`;
    }
    audience = `person:${name}`;
  }

  try {
    const row = await createSchedule(db, {
      kind: args.kind,
      spec: args.spec,
      prompt: args.prompt,
      threadId,
      timezone: config.timezone,
      label: args.label,
      audience,
    });
    const forWhom = audience ? ` for ${audience.slice('person:'.length)}` : '';
    return `Scheduled ${row.id} (${row.kind})${forWhom}; next run ${row.nextRunAt?.toISOString() ?? 'n/a'}.`;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * List the durable runs the caller can see (run-audiences Phase 3.2): active schedules they own
 * plus this conversation's running subagents. The owner (present in the thread) sees ALL schedules;
 * a family member sees only schedules whose audience subject is them. `'use step'` — pure read.
 */
async function listRunsStep(
  threadId: string,
  ownerPresent: boolean,
  callerSubject: string,
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { listSchedules } = await import('../src/scheduler/index.js');
  const { listRunningLinks } = await import('../src/agent/delegation.js');
  const { subjectName, scheduleAudience } = await import('../src/agent/audience.js');
  const { db, config } = await getRuntime();

  const scheds = await listSchedules(db);
  const visible = ownerPresent
    ? scheds
    : scheds.filter((s) => subjectName(scheduleAudience(s), config) === callerSubject);
  const children = (await listRunningLinks(db)).filter((l) => l.parentThreadId === threadId);

  const lines: string[] = [];
  if (visible.length > 0) {
    lines.push('Schedules:');
    for (const s of visible) {
      lines.push(
        `  ${s.id} [${s.kind} ${s.spec}]${s.label ? ` "${s.label}"` : ''} next ${s.nextRunAt?.toISOString() ?? 'n/a'}: ${s.prompt.slice(0, 50)}`,
      );
    }
  }
  if (children.length > 0) {
    lines.push('Subagents (working):');
    for (const l of children) lines.push(`  ${l.childThreadId} — ${l.task.slice(0, 50)}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no active runs)';
}

/**
 * Cancel a schedule or a running subagent of this conversation by id (run-audiences Phase 3.2),
 * ownership-scoped: the owner may cancel any run; a family member only a schedule whose subject is
 * them, or a subagent of this thread. `'use step'` so a replay never double-cancels.
 */
async function cancelRunStep(
  id: string,
  threadId: string,
  ownerPresent: boolean,
  callerSubject: string,
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { listSchedules, deleteSchedule } = await import('../src/scheduler/index.js');
  const { getLinkByChildThread, completeLink } = await import('../src/agent/delegation.js');
  const { subjectName, scheduleAudience } = await import('../src/agent/audience.js');
  const { db, config } = await getRuntime();

  const sched = (await listSchedules(db)).find((s) => s.id === id);
  if (sched) {
    const owner = subjectName(scheduleAudience(sched), config);
    if (!ownerPresent && owner !== callerSubject) {
      return `That schedule belongs to ${owner}, so I didn't cancel it.`;
    }
    const ok = await deleteSchedule(db, id);
    return ok ? `Cancelled schedule ${id}.` : `No schedule with id ${id}.`;
  }

  const link = await getLinkByChildThread(db, id);
  if (link && link.parentThreadId === threadId && link.status === 'running') {
    await completeLink(db, id, 'cancelled');
    return `Cancelled subagent ${id}; it will stop reporting to this conversation.`;
  }
  return `No run with id ${id} that you can cancel.`;
}

async function recallStep(query: string, limit?: number): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execRecall } = await import('../src/agent/tools/memory.js');
  const { store, config } = await getRuntime();
  return execRecall(store, config, query, limit);
}
