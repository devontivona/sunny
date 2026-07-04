import type { LanguageModelUsage, ModelCallStreamPart, ModelMessage } from '../src/agent/aiTypes.js';
import { WorkflowAgent } from '@ai-sdk/workflow';
import { getWritable } from 'workflow';
import { steerMessageText } from '../src/agent/delivery.js';
import { AGENT_STEP_LIMIT } from '../src/agent/limits.js';
import type { BashToolInput, FileReadToolInput } from '../src/agent/tools/bashSpecs.js';
import type { Audience } from '../src/agent/audience.js';

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
  /** Wrap folded steers in the relay envelope (config.inboundEnvelope), matching
   *  how the window's user messages were rendered. */
  envelope?: boolean;
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
  /** Compose one short update from the interim narration + the last few relayed
   *  updates. Returns '' for silence (the translator's default). */
  compose: (interim: string, recentUpdates: string[], stepNumber: number) => Promise<string>;
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
}

/**
 * Run the agent loop once — the shared body every profile used to duplicate: construct the
 * `WorkflowAgent`, stream with the standard durable wiring (`getWritable` to the run stream,
 * `stopWhen` at the step limit, telemetry OFF — the WDK isolated `node:vm` realm the global
 * telemetry integration can't reach, see vercel/ai #12164), and, when `steering` is set, fold
 * mid-run arrivals via `loadSteers` in `prepareStep` (no second stream consumer, deterministic on
 * replay). Returns the run `result`, the captured `usage`, and the ids it folded (so the caller can
 * mark exactly the window + folded steers answered).
 */
export async function streamAgent(opts: StreamAgentOpts): Promise<{
  result: Awaited<ReturnType<InstanceType<typeof WorkflowAgent>['stream']>>;
  usage: LanguageModelUsage | undefined;
  foldedIds: string[];
  /** The progress updates the translator relayed this turn (text mode; else empty). */
  translatorUpdates: { text: string; step: number }[];
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
                  text: steerMessageText(s.text, s.senderName, steering.isGroup, steering.envelope),
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
      const tr = opts.translator;
      if (tr && !folded && (stepNumber - 1) % tr.everyNSteps === 0) {
        const interim = stepNarration(steps.slice(translatorCursor));
        translatorCursor = steps.length;
        if (interim) {
          const recent = translatorUpdates.slice(-3).map((u) => u.text);
          const update = (await tr.compose(interim, recent, stepNumber)).trim();
          if (update) {
            await tr.send(update);
            translatorUpdates.push({ text: update, step: stepNumber });
          }
        }
      }

      return folded ? { messages: folded } : {};
    },
  });

  return { result, usage, foldedIds, translatorUpdates };
}

/** The narration text of a run of steps — the translator's interim source. Read from
 *  `steps[].content` (each step's freshly generated parts): on a tool-calls finish the
 *  agent's conversation prompt keeps only the tool calls, so the text exists NOWHERE
 *  else mid-run. Structural type: only `content` is touched. */
function stepNarration(
  steps: ReadonlyArray<{ content: ReadonlyArray<{ type: string; text?: string }> }>,
): string {
  const texts: string[] = [];
  for (const s of steps) {
    for (const p of s.content) {
      if (p.type === 'text' && p.text?.trim()) texts.push(p.text.trim());
    }
  }
  return texts.join('\n').trim();
}

/**
 * The single delivery bus (run-audiences D-RA15). Resolve an `Audience` to a Thread and dispatch on
 * its binding — the ONE outward seam every profile uses (the `send_message`/`message` tool executes
 * AND a run's terminal report). Memoized as a `'use step'`, so a replayed run never re-emits.
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
  const { isChildThread, appendInterRunMessage, reportToParent } = await import(
    '../src/agent/delegation.js'
  );
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
 * run (parent→child steer via `message_subagent`) — both fold the same way via `loadSteers`.
 * A `'use step'`, so it's deterministic on replay.
 */
export async function loadSteersStep(
  threadId: string,
  excludeIds: string[],
): Promise<{ messageId: string; text: string; senderName?: string }[]> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { store } = await getRuntime();
  return store.unansweredSteers(threadId, excludeIds);
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
  return readFileSafe(args.path, args.max_bytes);
}
