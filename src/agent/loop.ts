import {
  ToolLoopAgent,
  readUIMessageStream,
  stepCountIs,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type UIMessage,
} from 'ai';
import type { SunnyConfig } from '../config/index.js';
import type { ChannelEvent, Gateway } from '../gateway/types.js';
import type { ConversationStore } from '../gateway/store.js';
import type { Db } from '../db/client.js';
import { loadCore, memoryPaths } from '../memory/index.js';
import { logger } from '../logger.js';
import { ensureConsolidationSchedule } from '../scheduler/index.js';
import type { SteerHandle } from './dispatcher.js';
import { getModel, anthropicProviderOptions } from './model.js';
import { buildSystemPrompt } from './prompt.js';
import {
  classifyDelivery,
  extractScratch,
  extractSends,
  toModelMessages,
  trimTrailingNonUser,
} from './turn.js';
import { createMemoryTools } from './tools/memory.js';
import { createScheduleTools } from './tools/schedule.js';
import { createSendMessageTool, type SendCounter } from './tools/sendMessage.js';
import { createStartJobTool, type StartJob } from './tools/startJob.js';

const log = logger('agent:loop');

export interface AgentRunnerDeps {
  config: SunnyConfig;
  store: ConversationStore;
  gateway: Gateway;
  db: Db;
  /**
   * Test/eval seam (D13): override the language model. Production omits it and
   * the runner uses `getModel(config)` (the real Anthropic model).
   */
  model?: LanguageModel;
  /**
   * Test/eval seam (D13): override the durable-job starter threaded into
   * `start_job`. Production omits it and the tool uses the real WDK `start`.
   */
  start?: StartJob;
}

/**
 * In-process conversational turn (durable-execution Tier 1, D-DE1; task 2.5).
 *
 * Reads the recent window from Sunny's own store, runs an Opus `ToolLoopAgent`
 * with adaptive thinking, and replies.
 *
 * Output model (D-MG8): Sunny speaks ONLY by calling `send_message` (raw model
 * text is private). A telemetered safety net delivers the final text if a turn
 * produced no send — it should trend to zero; if it fires, the elicitation needs
 * work (it is not the intended path).
 */
export function createAgentRunner(deps: AgentRunnerDeps) {
  const { config, store, gateway, db } = deps;
  const model = deps.model ?? getModel(config);
  const paths = memoryPaths(config.runtimeDir);
  const memoryTools = createMemoryTools(config, store);

  return async function runTurn(event: ChannelEvent, steer: SteerHandle): Promise<void> {
    const startedAt = Date.now();
    await gateway.startTyping(event.threadId);

    // Seed the nightly memory-consolidation schedule once we know the owner's
    // delivery thread (4.7, idempotent). Fire-and-forget; never blocks the turn.
    if (event.isOwner && !event.isGroup) {
      void ensureConsolidationSchedule(db, event.threadId, config.timezone).catch((err) =>
        log.warn('ensureConsolidationSchedule failed', { err: String(err) }),
      );
    }

    // Always-on core is re-read per run (agent-memory D3), so hand-edits and
    // mid-turn writes take effect immediately.
    //
    // Cache the stable prefix (tools + system + memory core) with a 5-min
    // ephemeral breakpoint (D-PS4 / R2). Steps 2..N of a multi-step turn — and
    // any message within the TTL — then read it at ~0.1x instead of re-paying
    // full input price; the recent-window messages stay the uncached volatile
    // suffix. We deliberately skip cross-turn machinery (1-hr TTL / pre-warming):
    // low payoff for a single sporadic user, and memory writes change the prefix
    // between turns anyway. Verify via cachedIn / cacheWriteIn in the turn log.
    const instructions: SystemModelMessage = {
      role: 'system',
      content: buildSystemPrompt(config, loadCore(paths)),
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    };
    // The prompt must end with a user message (Anthropic rejects ending on an
    // assistant message). Stored turns are converted from their UIMessage payload
    // (D-MG9), so trim any trailing non-user messages (assistant + tool) back to
    // the last user message.
    const messages = trimTrailingNonUser(
      await toModelMessages(await store.recentWindow(event.threadId), event.isGroup),
    );
    if (messages.length === 0) {
      log.info('no user message to respond to; skipping turn', { threadId: event.threadId });
      return;
    }
    const counter: SendCounter = { count: 0 };
    const tools = {
      send_message: createSendMessageTool(gateway, event.threadId, counter),
      start_job: createStartJobTool(event.threadId, config.owner.name, deps.start),
      // Self-scheduling only on owner DMs (anti-recursion: scheduled runs never
      // get these tools; D-SC4). Non-owner/group turns can't schedule.
      ...(event.isOwner && !event.isGroup
        ? createScheduleTools(db, event.threadId, config.timezone)
        : {}),
      ...memoryTools,
    };
    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools,
      stopWhen: stepCountIs(20),
      providerOptions: anthropicProviderOptions(config),
      // Double-text steering (4.1b): fold any message that arrived mid-run into
      // the next step instead of starting a competing run.
      prepareStep: ({ messages: stepMessages }) => {
        const incoming = steer.drain();
        if (incoming.length === 0) return {};
        log.info('folding steer message(s) into run', {
          threadId: event.threadId,
          count: incoming.length,
        });
        const extra: ModelMessage[] = incoming.map((e) => ({
          role: 'user',
          content: event.isGroup && e.senderName ? `${e.senderName}: ${e.text}` : e.text,
        }));
        return { messages: [...stepMessages, ...extra] };
      },
    });

    try {
      const result = await agent.stream({ prompt: messages });

      // Consume the UI-message stream: this drives the tool loop to completion
      // and assembles the final assistant UIMessage (scratch text parts + every
      // tool part, incl. each send_message). That assembled message IS the
      // persisted turn record (D-MG9).
      let assistant: UIMessage | undefined;
      for await (const m of readUIMessageStream({ stream: result.toUIMessageStream() })) {
        assistant = m;
      }
      const [totalUsage, steps, finishReason] = await Promise.all([
        result.totalUsage,
        result.steps,
        result.finishReason,
      ]);

      const parts = assistant?.parts ?? [];
      const scratch = extractScratch(parts);
      const sent = extractSends(parts);

      const delivered = classifyDelivery(counter.count, scratch);
      if (delivered === 'fallback_text') {
        // The model wrote plain text but never called send_message. Raw model
        // text is PRIVATE (D-MG8) and is NOT delivered — auto-sending it would
        // leak working notes and contradict the prompt's promise. The user hears
        // nothing this turn; we log loudly so the elicitation miss stays visible
        // and measurable (watch this rate — it is the regression signal).
        log.warn('elicitation miss: model wrote text but never called send_message', {
          threadId: event.threadId,
          scratchLen: scratch.length,
        });
      }

      // One row per turn (D-MG9): persist the assembled UIMessage payload (rich,
      // for replay) + a flattened text projection (scratch + delivered sends, for
      // recall), with usage/delivery metadata. Skip a wholly empty turn.
      if (assistant && parts.length > 0) {
        const projection = [scratch, ...sent].filter(Boolean).join('\n');
        const enriched: UIMessage = {
          ...assistant,
          metadata: {
            ...(assistant.metadata as Record<string, unknown> | undefined),
            createdAt: new Date().toISOString(),
            model: config.modelId,
            usage: {
              in: totalUsage.inputTokens ?? null,
              out: totalUsage.outputTokens ?? null,
              cached: totalUsage.inputTokenDetails?.cacheReadTokens ?? null,
              cacheWrite: totalUsage.inputTokenDetails?.cacheWriteTokens ?? null,
            },
            delivered,
            steps: steps.length,
          },
        };
        await store.appendTurn(event.threadId, enriched, projection);
      }

      logTurnSummary(
        event,
        { totalUsage, steps, finishReason },
        counter.count,
        delivered,
        scratch.length,
        Date.now() - startedAt,
      );
    } catch (err) {
      log.error('agent turn failed', {
        threadId: event.threadId,
        err: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      await gateway.send(event.threadId, {
        text: 'Sorry — I hit an error handling that. Mind trying again?',
      });
    }
  };
}

/** Per-turn observability: tools used, delivery path, tokens, latency. */
function logTurnSummary(
  event: ChannelEvent,
  data: {
    totalUsage: LanguageModelUsage;
    steps: readonly unknown[];
    finishReason: string;
  },
  sendCount: number,
  delivered: string,
  scratchLen: number,
  ms: number,
): void {
  // Aggregate across steps — a single step's toolCalls only reflects that step.
  const toolCounts: Record<string, number> = {};
  for (const step of data.steps) {
    const calls = (step as { toolCalls?: Array<{ toolName?: string }> }).toolCalls ?? [];
    for (const call of calls) {
      if (call?.toolName) toolCounts[call.toolName] = (toolCounts[call.toolName] ?? 0) + 1;
    }
  }
  const usage = data.totalUsage;
  log.info('turn', {
    threadId: event.threadId,
    isGroup: event.isGroup,
    isOwner: event.isOwner,
    steps: data.steps.length,
    finish: data.finishReason,
    tools: toolCounts,
    sendCount,
    scratchLen,
    delivered,
    tokensIn: usage.inputTokens ?? null,
    tokensOut: usage.outputTokens ?? null,
    cachedIn: usage.inputTokenDetails?.cacheReadTokens ?? null,
    cacheWriteIn: usage.inputTokenDetails?.cacheWriteTokens ?? null,
    ms,
  });
}
