import type {
  LanguageModelUsage,
  ModelCallStreamPart,
  ModelMessage,
} from '../src/agent/aiTypes.js';
import { WorkflowAgent } from '@ai-sdk/workflow';
import { jsonSchema, tool } from '@ai-sdk/provider-utils';
import { getWritable } from 'workflow';
import { steerMessageText } from '../src/agent/delivery.js';
import { AGENT_STEP_LIMIT } from '../src/agent/limits.js';
import { BASH_TOOL_SPECS } from '../src/agent/tools/bashSpecs.js';
import type { BashToolInput, FileReadToolInput } from '../src/agent/tools/bashSpecs.js';
import { FILE_TOOL_SPECS } from '../src/agent/tools/fileSpecs.js';
import type { FileEditToolInput, FileWriteToolInput } from '../src/agent/tools/fileSpecs.js';
import { MEMORY_TOOL_SPECS } from '../src/agent/tools/memorySpecs.js';
import { RUNS_TOOL_SPECS } from '../src/agent/tools/scheduleSpecs.js';
import {
  CREDENTIAL_MANAGE_SPEC,
  type CredentialManageInput,
} from '../src/agent/tools/credentialManageSpecs.js';
import { MCP_MANAGE_SPEC, type McpManageInput } from '../src/agent/tools/mcpManageSpecs.js';
import type { McpToolDef } from '../src/mcp/turnTools.js';
import type { Audience, Authority } from '../src/agent/audience.js';

/**
 * Shared durable-run shell (durable-subagents D-DS11/D-DS14). The conversational turn, background
 * job, scheduled job, and delegated child are the SAME `WorkflowAgent` shell differing only in
 * config; the genuinely shared mechanism lives here so the per-trigger workflow entrypoints
 * (`conversation.ts`, `job.ts`, `scheduledJob.ts`, `subagent.ts`) stay thin and can never drift on
 * the agent loop, the outward-emit path, or the steering fold. WDK identifies a workflow by its
 * function and inputs must be serializable, so each trigger keeps its own thin `'use workflow'`
 * entrypoint that calls these helpers inline — this is "one shell" expressed as shared helpers, not
 * one function. Node-free at module scope (steps dynamic-import runtime modules), matching the rest
 * of the workflow code.
 */

type WorkflowAgentOptions = ConstructorParameters<typeof WorkflowAgent>[0];

/** Mid-run steering config (D-DS4): fold messages that arrive on `inboxThreadId` after the run
 *  starts. `baseExcludeIds` are ids the prompt already contains (the conversation's window;
 *  empty for a child whose only input is its brief); `isGroup` controls the sender prefix. */
export interface SteeringConfig {
  inboxThreadId: string;
  isGroup: boolean;
  baseExcludeIds: string[];
}

/**
 * Interim-progress translator wiring (text-delivery migration, Phase 3). Only the
 * conversational turn in text delivery mode passes this; jobs/children omit it (zero
 * change). The closures are `'use step'` calls supplied by the entrypoint (compose =
 * `translateStep`, send = the memoized delivery step), so on replay the journaled
 * results are reused and an update is never re-composed or re-sent.
 */
export interface TranslatorConfig {
  /** Cadence N (config.translatorEveryNSteps, via the journaled TurnSetup): fires at
   *  `stepNumber >= 1 && (stepNumber - 1) % N === 0` — the FIRST non-terminal step
   *  (the user gets an immediate "on it…" beat), then every N steps (1, 1+N, …). */
  everyNSteps: number;
  /** Compose one short update from the working notes + the last few relayed updates.
   *  `stepsSinceUpdate` = steps since the last SENT update (or since the turn began).
   *  Returns '' for silence (the translator's default). */
  compose: (
    interim: string,
    recentUpdates: string[],
    stepNumber: number,
    stepsSinceUpdate: number,
  ) => Promise<string>;
  /** Deliver a composed update (the memoized send step). */
  send: (text: string) => Promise<unknown>;
}

export interface StreamAgentOpts {
  model: WorkflowAgentOptions['model'];
  instructions: WorkflowAgentOptions['instructions'];
  tools: WorkflowAgentOptions['tools'];
  providerOptions?: WorkflowAgentOptions['providerOptions'];
  /** The initial prompt (a window for the conversation; one user message for a job/child). */
  messages: ModelMessage[];
  /** Present for steerable runs (conversation, child); omit for one-shot jobs. */
  steering?: SteeringConfig;
  /** Present for the text-mode conversational turn; omit everywhere else. */
  translator?: TranslatorConfig;
  /**
   * Mid-task `<report>…</report>` block delivery (subagent text-unification): present for
   * the delegated-child profile only. Each step's freshly generated text is scanned for
   * COMPLETE blocks at the step boundary (the same journaled-cursor pattern as the
   * translator fold) and each block's content is delivered via `send` (a memoized step —
   * replays never re-send) while the child keeps working. Blocks are child-authored and
   * deliberate, so they deliver regardless of folded steers. Blocks in the FINAL step's
   * text never reach a prepareStep — the caller handles those terminally.
   */
  reportBlocks?: { send: (text: string) => Promise<unknown> };
}

/**
 * Run the agent loop once — the shared body every profile used to duplicate: construct the
 * `WorkflowAgent`, stream with the standard durable wiring (`getWritable` to the run stream,
 * `stopWhen` at the step limit, WorkflowAgent telemetry OFF — it dispatches from the WDK isolated
 * `node:vm` realm the global telemetry integration can't reach AND that realm replays on every
 * resume, see vercel/ai #12164; durable-run generation spans are emitted instead by the
 * `ObservedLanguageModel` the profiles wrap their model in, host-side and exactly-once), and,
 * when `steering` is set, fold mid-run arrivals via `loadSteers` in `prepareStep` (no second
 * stream consumer, deterministic on replay). Returns the run `result`, the captured `usage`, and
 * the ids it folded (so the caller can mark exactly the window + folded steers answered).
 */
export async function streamAgent(opts: StreamAgentOpts): Promise<{
  result: Awaited<ReturnType<InstanceType<typeof WorkflowAgent>['stream']>>;
  usage: LanguageModelUsage | undefined;
  foldedIds: string[];
  /** The progress updates the translator relayed this turn (text mode; else empty). */
  translatorUpdates: { text: string; step: number }[];
  /** Mid-task report blocks delivered to the parent (child profile; else empty). */
  reportsSent: string[];
}> {
  let usage: LanguageModelUsage | undefined;
  const agent = new WorkflowAgent({
    model: opts.model,
    instructions: opts.instructions,
    tools: opts.tools,
    providerOptions: opts.providerOptions,
    onEnd: (e) => {
      usage = e.totalUsage;
    },
  });

  // Ids already seen by the model — the base prompt (window) plus steers folded so far — so
  // `loadSteers` only returns genuinely new mid-run arrivals.
  const foldedIds: string[] = [];
  const steering = opts.steering;

  // Translator fold state (text mode). Both derive purely from journaled step results —
  // `steps` reconstructs identically on replay and compose/send are memoized steps — so,
  // like `foldedIds`, they are deterministic across replays. The cursor indexes into
  // `steps` (NOT `messages`): on a tool-calls finish the agent's conversation prompt
  // carries only the tool calls — the step's narration TEXT lives only in
  // `steps[].content` (see @ai-sdk/workflow dist, conversationPrompt assembly).
  const translatorUpdates: { text: string; step: number }[] = [];
  let translatorCursor = 0;

  // Report-block fold state (child profile). Same determinism argument as the translator
  // cursor: derives purely from journaled step results; `send` is a memoized step.
  const reportsSent: string[] = [];
  let reportCursor = 0;

  // `prepareStep` is always present so its params infer from `agent.stream` (contextual typing); a
  // run with no `steering`/`translator` (a one-shot job) just no-ops it. For a steerable run it
  // folds mid-run arrivals on `inboxThreadId` via `loadSteers` — the double-text seam,
  // deterministic on replay — and, in text mode, relays interim progress on the cadence steps.
  const result = await agent.stream({
    messages: opts.messages,
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: ({ steps }) => steps.length >= AGENT_STEP_LIMIT,
    telemetry: { isEnabled: false },
    prepareStep: async ({ stepNumber, messages, steps }) => {
      if (stepNumber === 0) return {};
      let folded: typeof messages | undefined;
      if (steering) {
        const steers = await loadSteersStep(steering.inboxThreadId, [
          ...steering.baseExcludeIds,
          ...foldedIds,
        ]);
        if (steers.length > 0) {
          for (const s of steers) foldedIds.push(s.messageId);
          folded = [
            ...messages,
            ...steers.map((s) => ({
              role: 'user' as const,
              content: [
                {
                  type: 'text' as const,
                  text: steerMessageText(s.text, s.senderName, steering.isGroup),
                },
              ],
            })),
          ];
        }
      }

      // Progress translator (text mode): on cadence steps, relay the narration written since
      // the last update. Skipped when a steer folded THIS step — fresh user input beats stale
      // progress, and the model is about to react to it anyway. The cursor advances whenever
      // the trigger fires (even on empty narration or a declined update), so each pass sees
      // only genuinely new notes.
      // Mid-task report blocks (child profile): scan the steps completed since the last
      // boundary for complete <report> blocks and deliver each immediately.
      if (opts.reportBlocks) {
        const { extractReportBlocks } = await import('../src/agent/delivery.js');
        const newText = stepNarrationText(steps.slice(reportCursor));
        reportCursor = steps.length;
        for (const report of extractReportBlocks(newText).reports) {
          await opts.reportBlocks.send(report);
          reportsSent.push(report);
        }
      }

      const tr = opts.translator;
      if (tr && !folded && (stepNumber - 1) % tr.everyNSteps === 0) {
        // Notes ACCUMULATE across declined beats: the cursor advances only when an update
        // is actually sent. (2026-07-05 investigation: advancing on decline gave every
        // beat a ~3-step window, so the translator's "quick work" rule matched every
        // window of a 15-step turn — 9/9 declines on exactly the turns the feature is
        // for. Accumulation lets long-task evidence build until it has a reason to speak.)
        const interim = stepNarration(steps.slice(translatorCursor));
        if (interim) {
          const lastUpdateStep = translatorUpdates[translatorUpdates.length - 1]?.step ?? 0;
          const recent = translatorUpdates.slice(-3).map((u) => u.text);
          const update = (
            await tr.compose(interim, recent, stepNumber, stepNumber - lastUpdateStep)
          ).trim();
          if (update) {
            await tr.send(update);
            translatorUpdates.push({ text: update, step: stepNumber });
            translatorCursor = steps.length;
          }
        }
      }

      return folded ? { messages: folded } : {};
    },
  });

  return { result, usage, foldedIds, translatorUpdates, reportsSent };
}

/** The plain narration TEXT of a run of steps (no tool-call log lines) — the report-block
 *  scan source. */
function stepNarrationText(
  steps: ReadonlyArray<{ content: ReadonlyArray<{ type: string; text?: string }> }>,
): string {
  const texts: string[] = [];
  for (const s of steps) {
    for (const p of s.content) {
      if (p.type === 'text' && p.text?.trim()) texts.push(p.text);
    }
  }
  return texts.join('\n');
}

/**
 * The working notes of a run of steps — the translator's interim source: any narration
 * TEXT the model wrote, plus a brief line per TOOL CALL (`[ran bash: curl …]`, the
 * recovery-pass transcript trick). The tool-call log matters: with extended thinking on,
 * the model narrates into private reasoning (dropped), not text — measured across a full
 * grid, multi-step turns produced ZERO narration text, so tool calls are usually the only
 * observable progress signal. Read from `steps[].content` (each step's freshly generated
 * parts): on a tool-calls finish the agent's conversation prompt keeps only the tool
 * calls, so this exists NOWHERE else mid-run. Structural type: only `content` is touched.
 */
function stepNarration(
  steps: ReadonlyArray<{
    content: ReadonlyArray<{ type: string; text?: string; toolName?: string; input?: unknown }>;
  }>,
): string {
  const brief = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  };
  const lines: string[] = [];
  for (const s of steps) {
    for (const p of s.content) {
      if (p.type === 'text' && p.text?.trim()) {
        lines.push(p.text.trim());
      } else if (p.type === 'tool-call' && p.toolName) {
        const input = p.input as Record<string, unknown> | undefined;
        lines.push(`[ran ${p.toolName}: ${brief(input?.command ?? input)}]`);
      }
    }
  }
  return lines.join('\n').trim();
}

/**
 * The single delivery bus (run-audiences D-RA15). Resolve an `Audience` to a Thread and dispatch on
 * its binding — the ONE outward seam every profile uses (the conversation's reply bubbles, the
 * `message` tool, a child's report, AND a run's terminal deliver). Memoized as a `'use step'`, so a replayed run never re-emits.
 *  - household → nothing (no single recipient; the run fans out via the `message` tool). A household
 *                run with no messaging grant is thus structurally silent.
 *  - parent    → append to the parent run's inbox + wake its run-supply (attributed via from*),
 *                folded by `loadSteers` — the detached-mailbox path (D-DS4).
 *  - person    → resolve the roster member to their BOUND DM at delivery time; if unresolvable
 *                (never-contacted / removed), record nothing here and notify the owner (D-RA2).
 *  - thread    → bound (a real conversation) → gateway; detached (`subagent:` inbox) → append+wake.
 */
export async function deliver(audience: Audience, text: string): Promise<void> {
  'use step';

  if (!text || audience.kind === 'household') return;

  const { getRuntime } = await import('../src/runtime.js');
  const { isChildThread, appendInterRunMessage, reportToParent } =
    await import('../src/agent/delegation.js');
  const runtime = await getRuntime();

  if (audience.kind === 'parent') {
    await reportToParent(
      runtime,
      { threadId: audience.threadId, fromId: audience.fromId, fromName: audience.fromName },
      text,
    );
    return;
  }

  // Resolve a `person` audience to a concrete bound thread, or notify the owner it's undeliverable.
  let threadId: string;
  if (audience.kind === 'person') {
    const resolved = await resolvePersonThread(runtime, audience.person);
    if (!resolved) {
      await notifyOwnerUndeliverable(runtime, audience.person, text);
      return;
    }
    threadId = resolved;
  } else {
    threadId = audience.threadId;
  }

  // Dispatch on the mailbox binding: detached (internal `subagent:` inbox) → append only; bound →
  // gateway. A detached inbox is NOT woken here — an in-flight recipient folds it via `loadSteers`,
  // a finished one is run-to-completion. This mirrors `reportToParent`, which deliberately does not
  // wake a child inbox (waking would wrongly start a conversation turn on an internal thread).
  if (isChildThread(threadId)) {
    await appendInterRunMessage(runtime.store, threadId, { id: 'run', name: 'run' }, text);
  } else {
    await runtime.gateway.send(threadId, { text });
  }
}

/** Resolve a roster member to their existing bound DM thread, or construct one from
 *  `SENDBLUE_FROM_NUMBER`. Returns null when the person is off-roster or no thread can be formed. */
async function resolvePersonThread(
  runtime: Awaited<ReturnType<typeof import('../src/runtime.js').getRuntime>>,
  person: string,
): Promise<string | null> {
  const { normalize } = await import('../src/gateway/auth.js');
  const { sendblueDmThreadId } = await import('../src/gateway/threadId.js');
  const { resolveRosterMember } = await import('../src/agent/audience.js');
  const member = resolveRosterMember(person, runtime.config);
  if (!member) return null;
  // Matching is centralized (resolveRosterMember); thread ENCODING uses the gateway's `normalize`
  // (the same canonicalization the adapter uses for thread ids), so a resolved member addresses
  // the same thread the adapter would.
  const identity = normalize(member.identity);
  const existing = await runtime.store.findDmThreadForSender(identity);
  if (existing) return existing;
  const from = process.env.SENDBLUE_FROM_NUMBER;
  return from ? sendblueDmThreadId(from, identity) : null;
}

/** A `person` audience that couldn't be resolved at delivery time (D-RA2): don't drop the message
 *  silently — surface it to the owner's DM so a scheduled reminder for a never-contacted person
 *  becomes visible instead of vanishing. Best-effort. */
async function notifyOwnerUndeliverable(
  runtime: Awaited<ReturnType<typeof import('../src/runtime.js').getRuntime>>,
  person: string,
  text: string,
): Promise<void> {
  try {
    const { normalize } = await import('../src/gateway/auth.js');
    const { sendblueDmThreadId } = await import('../src/gateway/threadId.js');
    const ownerId = runtime.config.owner.identities[0];
    const from = process.env.SENDBLUE_FROM_NUMBER;
    if (!ownerId || !from) return;
    const ownerThread = sendblueDmThreadId(from, normalize(ownerId));
    await runtime.gateway.send(ownerThread, {
      text: `I couldn't reach "${person}" (no conversation with them yet), so this went undelivered: ${text}`,
    });
  } catch {
    // best-effort — never throw out of the bus
  }
}

/**
 * Read messages that arrived on `threadId` that the run hasn't folded yet (D-DS4 steering),
 * excluding ids already seen. Shared by the conversation turn (owner double-text) and a child
 * run (parent→child steer via `message`) — both fold the same way via `loadSteers`.
 * A `'use step'`, so it's deterministic on replay.
 *
 * MEDIA-bearing arrivals are NOT returned (multipart-coalesce, 2026-07-07): the fold is
 * text-only, so folding an image would consume it unseen — the model never gets the bytes,
 * but `foldedIds` marks it answered. Left unfolded, it stays unanswered and the router's next
 * turn reads it from the window with the media properly inlined. (The filter lives INSIDE the
 * step so the journal records exactly what was folded.)
 */
export async function loadSteersStep(
  threadId: string,
  excludeIds: string[],
): Promise<{ messageId: string; text: string; senderName?: string }[]> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { store } = await getRuntime();
  const steers = await store.unansweredSteers(threadId, excludeIds);
  return steers
    .filter((s) => !s.hasMedia)
    .map(({ messageId, text, senderName }) => ({ messageId, text, senderName }));
}

/** Mark a thread's inbound messages answered (the watermark) — shared across profiles. */
export async function markAnsweredStep(threadId: string, messageIds: string[]): Promise<void> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { store } = await getRuntime();
  await store.markAnsweredForThread(threadId, messageIds);
}

/** Final assistant text from a run's messages — the terminal report/deliver payload (D-DS14
 *  `recoverOnMiss: rawtext`). Shared by job/scheduled/child finalize. */
export function finalAssistantText(messages: ModelMessage[]): string {
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

/** Run a host shell command as a durable step (shared host-tool execute). */
export async function bashStep(args: BashToolInput): Promise<string> {
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

/** Read a host file as a durable step (shared host-tool execute). */
export async function fileReadStep(args: FileReadToolInput): Promise<string> {
  'use step';

  const { readFileSafe } = await import('../src/agent/tools/bash.js');
  return readFileSafe(args.path, {
    offset: args.offset,
    limit: args.limit,
    maxBytes: args.max_bytes,
  });
}

/** Create/overwrite a host file as a durable step (shared host-tool execute). */
export async function fileWriteStep(args: FileWriteToolInput): Promise<string> {
  'use step';

  const { writeFileSafe } = await import('../src/agent/tools/bash.js');
  return writeFileSafe(args.path, args.content);
}

/** Exact-string-edit a host file as a durable step (shared host-tool execute). */
export async function fileEditStep(args: FileEditToolInput): Promise<string> {
  'use step';

  const { editFileSafe } = await import('../src/agent/tools/bash.js');
  return editFileSafe(args.path, args.old_string, args.new_string, args.replace_all ?? false);
}

/** Write to the memory core as a durable step (shared memory execute). `ownerScope` gates the
 *  owner-only core files (USER.md, SUNNY.md; multiplayer-family D2): false refuses those edits,
 *  true (an owner-scoped run) permits them. A replay never re-applies (add appends). */
export async function memoryWriteStep(args: {
  file: string;
  action: 'add' | 'replace' | 'remove';
  content?: string;
  target?: string;
  ownerScope: boolean;
}): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execMemoryWrite } = await import('../src/agent/tools/memory.js');
  const { config } = await getRuntime();
  const fileKey = args.file.trim().toUpperCase();
  if (!args.ownerScope && (fileKey === 'USER' || fileKey === 'SUNNY')) {
    return (
      `ERROR: editing ${fileKey}.md is restricted to the owner. ` +
      `Record durable facts about another person with file "people:<id>" instead.`
    );
  }
  const { file, action, content, target } = args;
  return execMemoryWrite(config, { file, action, content, target });
}

/** Read a memory topic doc as a durable step (shared memory execute). */
export async function readTopicStep(name: string): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execReadTopic } = await import('../src/agent/tools/memory.js');
  const { config } = await getRuntime();
  return execReadTopic(config, name);
}

/** Search conversation history as a durable step (shared memory execute). */
export async function recallStep(query: string, limit?: number): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execRecall } = await import('../src/agent/tools/memory.js');
  const { store, config } = await getRuntime();
  return execRecall(store, config, query, limit);
}

/**
 * List the durable runs the caller can see (run-audiences Phase 3.2): active schedules they own
 * plus `threadId`'s running subagents. An owner-scoped caller sees ALL schedules; anyone else only
 * schedules whose audience subject is them. `'use step'` — pure read. Shared across profiles
 * (the conversation's `list_runs` and any run holding the `runs_read` grant).
 */
export async function listRunsStep(
  threadId: string,
  ownerScope: boolean,
  callerSubject: string,
): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { listSchedules } = await import('../src/scheduler/index.js');
  const { listRunningLinks } = await import('../src/agent/delegation.js');
  const { subjectName, scheduleAudience } = await import('../src/agent/audience.js');
  const { db, config } = await getRuntime();

  const scheds = await listSchedules(db);
  const visible = ownerScope
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

/** Credential-registry actions (list/discover/register) as a durable step. The resolver comes
 *  from env exactly like `bashStep`'s injection path, so "register" verifies against the SAME
 *  1Password client the bash `credentials` argument resolves through. Journaled — a replayed
 *  run never re-registers. */
export async function credentialManageStep(args: CredentialManageInput): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execCredentialManage } = await import('../src/agent/tools/credentialManage.js');
  const { resolverFromEnv } = await import('../src/credentials/index.js');
  const { config } = await getRuntime();
  return execCredentialManage(config, resolverFromEnv() ?? undefined, args);
}

/** MCP-registry actions (add/probe/test/list/enable/disable/remove) as a durable step —
 *  `credential_manage`'s sibling. No consent driver: an OAuth authorization URL is returned
 *  in the result text for Sunny to relay. Journaled — a replayed run never re-adds. */
export async function mcpManageStep(args: McpManageInput): Promise<string> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { execMcpManage } = await import('../src/agent/tools/mcpManage.js');
  const { resolverFromEnv } = await import('../src/credentials/index.js');
  const { config } = await getRuntime();
  return execMcpManage(config, resolverFromEnv() ?? undefined, {}, args);
}

/** One MCP tool invocation as a durable step (connect → call → close on the host;
 *  mcp D-MCP6/7). Never throws — a flaky server degrades to an `ERROR …` result the model
 *  reads, instead of failing (and WDK-retrying) the run. Journaled — a replayed run
 *  never re-invokes a server tool. */
export async function mcpCallStep(
  server: string,
  toolName: string,
  input: unknown,
): Promise<unknown> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { callMcpTool } = await import('../src/mcp/turnTools.js');
  const { resolverFromEnv } = await import('../src/credentials/index.js');
  const { config } = await getRuntime();
  return callMcpTool(config, resolverFromEnv() ?? undefined, server, toolName, input);
}

/** Context `grantTools` needs beyond the grant list itself. */
export interface GrantToolsCtx {
  /** May this run edit the owner-only core files (USER.md/SUNNY.md)? Conversation turns pass
   *  `ownerPresent`; spawned runs inherit their creator's scope. */
  ownerScope: boolean;
  /** `list_runs` scoping (`runs_read`): the thread whose subagents are visible + the caller's
   *  canonical subject name. */
  runs?: { threadId: string; subject: string };
  /** Live MCP server tool defs discovered in the profile's setup step (`mcp` grant) — plain
   *  data, so it journals across the step boundary. */
  mcpTools?: McpToolDef[];
}

/**
 * The grant → tool-bundle mapping (run-audiences D-RA5) — ONE builder shared by every run
 * profile, so "what does grant X let a run do" can never drift between the conversation, a
 * subagent, and a scheduled run. Covers the profile-generic grants only; profile-specific verbs
 * (send_image, message, delegate_task, schedule_create, cancel_run) are registered by their
 * profiles with profile-local executes. Every execute is a journaled `'use step'`.
 */
export function grantTools(grants: Authority, ctx: GrantToolsCtx) {
  const has = (g: string) => grants.includes(g);
  return {
    ...(has('memory_read')
      ? {
          read_topic: tool({
            ...MEMORY_TOOL_SPECS.read_topic,
            execute: ({ name }: { name: string }) => readTopicStep(name),
          }),
          recall_history: tool({
            ...MEMORY_TOOL_SPECS.recall_history,
            execute: ({ query, limit }: { query: string; limit?: number }) =>
              recallStep(query, limit),
          }),
        }
      : {}),
    ...(has('memory_write')
      ? {
          memory_write: tool({
            ...MEMORY_TOOL_SPECS.memory_write,
            execute: (args: {
              file: string;
              action: 'add' | 'replace' | 'remove';
              content?: string;
              target?: string;
            }) => memoryWriteStep({ ...args, ownerScope: ctx.ownerScope }),
          }),
        }
      : {}),
    ...(has('runs_read') && ctx.runs
      ? {
          list_runs: tool({
            ...RUNS_TOOL_SPECS.list_runs,
            execute: () => listRunsStep(ctx.runs!.threadId, ctx.ownerScope, ctx.runs!.subject),
          }),
        }
      : {}),
    ...(has('file_read')
      ? { file_read: tool({ ...BASH_TOOL_SPECS.file_read, execute: (a) => fileReadStep(a) }) }
      : {}),
    ...(has('bash')
      ? { bash: tool({ ...BASH_TOOL_SPECS.bash, execute: (a) => bashStep(a) }) }
      : {}),
    ...(has('file_write')
      ? {
          file_write: tool({ ...FILE_TOOL_SPECS.file_write, execute: (a) => fileWriteStep(a) }),
          file_edit: tool({ ...FILE_TOOL_SPECS.file_edit, execute: (a) => fileEditStep(a) }),
        }
      : {}),
    ...(has('credentials')
      ? {
          credential_manage: tool({
            ...CREDENTIAL_MANAGE_SPEC,
            execute: (args) => credentialManageStep(args),
          }),
        }
      : {}),
    ...(has('mcp')
      ? {
          mcp_manage: tool({ ...MCP_MANAGE_SPEC, execute: (args) => mcpManageStep(args) }),
          // Live MCP server tools (mcp D-MCP6/7), namespaced `<server>__<tool>` to avoid
          // clobbering native tools; the schema is the server's own JSON Schema; results are
          // untrusted content.
          ...Object.fromEntries(
            (ctx.mcpTools ?? []).map((d) => [
              `${d.server}__${d.name}`,
              tool({
                description: d.description,
                inputSchema: jsonSchema<Record<string, unknown>>(d.inputSchema),
                execute: (args) => mcpCallStep(d.server, d.name, args),
              }),
            ]),
          ),
        }
      : {}),
  };
}
