import { ToolLoopAgent, stepCountIs, type ModelMessage, type SystemModelMessage } from 'ai';
import type { SunnyConfig } from '../config/index.js';
import type { ChannelEvent, Gateway } from '../gateway/types.js';
import type { ConversationStore, StoredMessage } from '../gateway/store.js';
import type { Db } from '../db/client.js';
import { loadCore, memoryPaths } from '../memory/index.js';
import { logger } from '../logger.js';
import { ensureConsolidationSchedule } from '../scheduler/index.js';
import type { SteerHandle } from './dispatcher.js';
import { getModel, anthropicProviderOptions } from './model.js';
import { buildSystemPrompt } from './prompt.js';
import { createMemoryTools } from './tools/memory.js';
import { createScheduleTools } from './tools/schedule.js';
import { createSendMessageTool, type SendCounter } from './tools/sendMessage.js';
import { createStartJobTool } from './tools/startJob.js';

const log = logger('agent:loop');

export interface AgentRunnerDeps {
  config: SunnyConfig;
  store: ConversationStore;
  gateway: Gateway;
  db: Db;
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
    const messages = toModelMessages(await store.recentWindow(event.threadId), event.isGroup);
    // The prompt must end with a user message (Anthropic rejects ending on an
    // assistant message). The window is insertion-ordered, so it can end with
    // one of Sunny's own replies (e.g. a follow-up turn after a steered message
    // whose reply was persisted later). Sunny's replies are now reconstructed as
    // send_message tool-call + tool-result pairs (see toModelMessages), so trim
    // any trailing assistant/tool messages (whole pairs) back to the last user.
    while (messages.length > 0 && messages[messages.length - 1]?.role !== 'user') {
      messages.pop();
    }
    if (messages.length === 0) {
      log.info('no user message to respond to; skipping turn', { threadId: event.threadId });
      return;
    }
    const counter: SendCounter = { count: 0 };
    const tools = {
      send_message: createSendMessageTool(gateway, event.threadId, counter),
      start_job: createStartJobTool(event.threadId, config.owner.name),
      // Self-scheduling only on owner DMs (anti-recursion: scheduled runs never
      // get these tools; D-SC4). Non-owner/group turns can't schedule.
      ...(event.isOwner && !event.isGroup
        ? createScheduleTools(db, event.threadId, config.timezone)
        : {}),
      ...memoryTools,
    };
    const agent = new ToolLoopAgent({
      model: getModel(config),
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
      const result = await agent.generate({ prompt: messages });

      let delivered: 'send_message' | 'fallback_text' | 'silence';
      if (counter.count > 0) {
        // Intended path: Sunny spoke via send_message (one or more bubbles).
        delivered = 'send_message';
      } else if (result.text.trim()) {
        // Safety net, NOT the design: the model put its reply in private scratch
        // instead of calling send_message. Deliver it so the user isn't ghosted,
        // but flag loudly — this should trend to zero as the elicitation holds.
        log.warn('no send_message; delivering scratch text as fallback (fix elicitation)', {
          threadId: event.threadId,
        });
        await gateway.send(event.threadId, { text: result.text.trim() });
        delivered = 'fallback_text';
      } else {
        delivered = 'silence';
      }

      logTurnSummary(
        event,
        result as unknown as TurnResult,
        counter.count,
        delivered,
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

/** Minimal shape of the bits of the generate result we report on. */
interface TurnResult {
  steps?: Array<{ toolCalls?: Array<{ toolName: string }> }>;
  finishReason?: string;
  text?: string;
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    // Aggregated across steps (cleaner than per-call providerMetadata, which only
    // reflects the final step). cacheReadTokens === cachedInputTokens.
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  };
}

/** Per-turn observability: tools used, delivery path, tokens, latency. */
function logTurnSummary(
  event: ChannelEvent,
  result: TurnResult,
  sendCount: number,
  delivered: string,
  ms: number,
): void {
  // Aggregate across steps — result.toolCalls only reflects the final step.
  const toolCounts: Record<string, number> = {};
  for (const step of result.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      toolCounts[call.toolName] = (toolCounts[call.toolName] ?? 0) + 1;
    }
  }
  const usage = result.totalUsage;
  log.info('turn', {
    threadId: event.threadId,
    isGroup: event.isGroup,
    isOwner: event.isOwner,
    steps: result.steps?.length ?? 1,
    finish: result.finishReason,
    tools: toolCounts,
    sendCount,
    textLen: result.text?.length ?? 0,
    delivered,
    tokensIn: usage?.inputTokens ?? null,
    tokensOut: usage?.outputTokens ?? null,
    cachedIn: usage?.cachedInputTokens ?? null,
    cacheWriteIn: usage?.inputTokenDetails?.cacheWriteTokens ?? null,
    ms,
  });
}

/**
 * Build the model prompt from the stored recent window. Inbound → user; each of
 * Sunny's own replies → a `send_message` tool-call + `delivered` tool-result pair.
 *
 * Reconstructing outbound messages the way they actually happened (a tool call,
 * not plain assistant text) makes the model's own history demonstrate that the
 * only way to speak is to call `send_message` (D-MG8) — closing the elicitation
 * slip where it would otherwise mimic a plain-text self-history. The synthetic
 * `toolCallId` only needs to be unique within this prompt and pair the call with
 * its result; we don't persist the original. (Non-send tools like memory_write
 * aren't in the store, so this is a send-only reconstruction — which sharpens the
 * signal rather than weakening it.)
 *
 * In groups, prefix the speaker on inbound messages so the model can follow who
 * said what (it answers everyone but only acts for the owner — R1).
 */
function toModelMessages(window: StoredMessage[], isGroup: boolean): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of window) {
    if (m.role === 'assistant') {
      const toolCallId = `send-${m.messageId}`;
      out.push({
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId, toolName: 'send_message', input: { text: m.text } },
        ],
      });
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: 'send_message',
            output: { type: 'text', value: 'delivered' },
          },
        ],
      });
      continue;
    }
    const content =
      isGroup && m.senderName ? `${m.senderName}${m.isOwner ? ' (owner)' : ''}: ${m.text}` : m.text;
    out.push({ role: 'user', content });
  }
  return out;
}
