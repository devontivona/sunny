import type { LanguageModelUsage, ModelCallStreamPart, ModelMessage } from '../src/agent/aiTypes.js';
import { WorkflowAgent } from '@ai-sdk/workflow';
import { getWritable } from 'workflow';
import { steerMessageText } from '../src/agent/delivery.js';
import { AGENT_STEP_LIMIT } from '../src/agent/limits.js';
import type { BashToolInput, FileReadToolInput } from '../src/agent/tools/bashSpecs.js';
import type { EmitTarget } from '../src/agent/outputTarget.js';

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

export interface StreamAgentOpts {
  model: WorkflowAgentOptions['model'];
  instructions: WorkflowAgentOptions['instructions'];
  tools: WorkflowAgentOptions['tools'];
  providerOptions?: WorkflowAgentOptions['providerOptions'];
  /** The initial prompt (a window for the conversation; one user message for a job/child). */
  messages: ModelMessage[];
  /** Present for steerable runs (conversation, child); omit for one-shot jobs. */
  steering?: SteeringConfig;
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

  // `prepareStep` is always present so its params infer from `agent.stream` (contextual typing); a
  // run with no `steering` (a one-shot job) just no-ops it. For a steerable run it folds mid-run
  // arrivals on `inboxThreadId` via `loadSteers` — the double-text seam, deterministic on replay.
  const result = await agent.stream({
    messages: opts.messages,
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: ({ steps }) => steps.length >= AGENT_STEP_LIMIT,
    telemetry: { isEnabled: false },
    prepareStep: async ({ stepNumber, messages }) => {
      if (!steering || stepNumber === 0) return {};
      const steers = await loadSteersStep(steering.inboxThreadId, [
        ...steering.baseExcludeIds,
        ...foldedIds,
      ]);
      if (steers.length === 0) return {};
      for (const s of steers) foldedIds.push(s.messageId);
      return {
        messages: [
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
        ],
      };
    },
  });

  return { result, usage, foldedIds };
}

/**
 * The single outward primitive (D-DS14): emit `text`, routed by `output_target`. BOTH the
 * `send_message` tool's `execute` AND the finalize backstop (a job's terminal "deliver") call
 * this — there is no separate `deliver`. Memoized as a `'use step'`, so a replayed run never
 * re-emits.
 *  - silent → nothing (the run still records its result elsewhere; see each profile's finalize)
 *  - user   → `gateway.send(destThreadId)` (owner via the messaging gateway)
 *  - parent → append the message to the parent run's inbox thread as a steer its next run folds
 *             via `loadSteers`, then wake the parent's run-supply (the supervisor) — D-DS4.
 */
export async function emitStep(out: EmitTarget, text: string): Promise<void> {
  'use step';

  if (out.target === 'silent' || !text) return;

  const { getRuntime } = await import('../src/runtime.js');
  const runtime = await getRuntime();

  if (out.target === 'parent') {
    // Delegated child → parent: append to the parent's inbox thread + wake its run-supply.
    const { reportToParent } = await import('../src/agent/delegation.js');
    await reportToParent(runtime, out, text);
    return;
  }

  // user (the default): deliver to the owner thread via the gateway.
  await runtime.gateway.send(out.destThreadId, { text });
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
