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
import type { CredentialResolver } from '../credentials/index.js';
import { loadCore, memoryPaths } from '../memory/index.js';
import { loadSkillIndex, skillsPaths } from '../skills/index.js';
import { logger } from '../logger.js';
import { ensureConsolidationSchedule } from '../scheduler/index.js';
import type { SteerHandle } from './dispatcher.js';
import { getModel, getRecoveryModel, anthropicProviderOptions } from './model.js';
import { buildSystemPrompt, type DeliveryMode } from './prompt.js';
import { runRecoveryPass } from './recovery.js';
import {
  classifyDelivery,
  extractScratch,
  extractSends,
  sendMessagePart,
  splitBubbles,
  toModelMessages,
  trimTrailingNonUser,
  type Delivery,
} from './turn.js';
import { createMemoryTools } from './tools/memory.js';
import { createScheduleTools } from './tools/schedule.js';
import { createSkillTools } from './tools/skillManage.js';
import { createCredentialTools } from './tools/credentialManage.js';
import { createBashTools } from './tools/bash.js';
import { createSendMessageTool, type SendCounter } from './tools/sendMessage.js';
import { createStaySilentTool, type SilenceFlag } from './tools/staySilent.js';
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
  /**
   * Credential resolver (credentials D-CR2). Production builds it from
   * `OP_SERVICE_ACCOUNT_TOKEN`; tools resolve a credential by name via the registry
   * (`resolveByName`, D-CR5). Absent when no token is configured — `credential_manage`
   * register then records without verifying, and credentialed tools are unavailable.
   */
  credentials?: CredentialResolver;
  /**
   * Test/eval seam: override the cheap model used by the delivery-recovery pass
   * (D-MG8). Production omits it and uses `getRecoveryModel(config)` (Haiku).
   */
  recoveryModel?: LanguageModel;
  /**
   * Output design (experimental). `tool` (default, current D-MG8): the model speaks
   * only via `send_message`. `text`: the model's reply text is delivered directly
   * (no `send_message` tool), `stay_silent` chooses silence, no recovery pass.
   */
  deliveryMode?: DeliveryMode;
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
  const recoveryModel = deps.recoveryModel ?? getRecoveryModel(config);
  const deliveryMode: DeliveryMode = deps.deliveryMode ?? 'tool';
  const paths = memoryPaths(config.runtimeDir);
  const skillPaths = skillsPaths(config.runtimeDir);
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
      content: buildSystemPrompt(
        config,
        loadCore(paths),
        deliveryMode,
        loadSkillIndex(skillPaths, config.skills),
      ),
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
    const silence: SilenceFlag = { silent: false };
    const sendMessageTool = createSendMessageTool(gateway, event.threadId, counter);
    const staySilentTool = createStaySilentTool(silence);
    const tools = {
      // Text mode delivers the reply text directly, so there is no send_message tool.
      ...(deliveryMode === 'tool' ? { send_message: sendMessageTool } : {}),
      stay_silent: staySilentTool,
      start_job: createStartJobTool(event.threadId, config.owner.name, deps.start),
      // Self-scheduling only on owner DMs (anti-recursion: scheduled runs never
      // get these tools; D-SC4). Non-owner/group turns can't schedule.
      ...(event.isOwner && !event.isGroup
        ? createScheduleTools(db, event.threadId, config.timezone)
        : {}),
      // Self-authoring skills: owner DMs only (privileged, owner-facing; D-SK4).
      ...(event.isOwner && !event.isGroup ? createSkillTools(config) : {}),
      // Credential registry: owner DMs only (D-CR5). resolver verifies on register.
      ...(event.isOwner && !event.isGroup ? createCredentialTools(config, deps.credentials) : {}),
      // Host tools (bash, file_read): owner DMs only — real host access, attended
      // only until command-permissioning lands (security-permissions; D-TA2).
      ...(event.isOwner && !event.isGroup ? createBashTools(config, deps.credentials) : {}),
      ...memoryTools,
    };
    let stepNo = 0;
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
      // Live per-step trace — see the loop as it runs (each model step + its tool
      // calls/results), not just the end-of-turn summary. Credential values are
      // already masked by the tools; tool inputs carry only references/names.
      onStepFinish: (step) => {
        stepNo += 1;
        const calls = step.toolCalls.flatMap((c) =>
          c ? [`${c.toolName}(${previewArg(c.input)})`] : [],
        );
        const results = step.toolResults.flatMap((r) =>
          r ? [`${r.toolName} → ${previewArg((r as { output?: unknown }).output)}`] : [],
        );
        log.info('turn step', {
          threadId: event.threadId,
          step: stepNo,
          finish: step.finishReason,
          ...(calls.length ? { calls } : {}),
          ...(results.length ? { results } : {}),
          ...(step.text.trim() ? { text: previewArg(step.text) } : {}),
        });
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

      let parts = assistant?.parts ?? [];
      const scratch = extractScratch(parts);

      let delivered: Delivery;
      let recovered = false;
      let projection: string;

      if (deliveryMode === 'text') {
        // Text mode: the assistant's reply text IS the message. Deliver it as
        // iMessage bubbles (split on blank lines), unless the model affirmatively
        // chose silence (stay_silent) or produced no text. No recovery pass — text
        // is always delivered, so there is no missed-send to recover from.
        const bubbles = silence.silent ? [] : splitBubbles(scratch);
        for (const text of bubbles) {
          await gateway.send(event.threadId, { text }, { persist: false });
        }
        delivered = bubbles.length > 0 ? 'send_message' : 'silence';
        projection = bubbles.join('\n');
      } else {
        delivered = classifyDelivery(counter.count, scratch, silence.silent);
        if (delivered === 'fallback_text') {
          // Elicitation miss: the model wrote text but called NEITHER send_message
          // nor stay_silent. Run a cheap forced recovery pass (D-MG8) that composes
          // a concise message from the private notes, or affirmatively chooses
          // silence — so the reply isn't ghosted and raw scratch is never leaked.
          log.warn('elicitation miss; running delivery recovery', {
            threadId: event.threadId,
            scratchLen: scratch.length,
          });
          try {
            const recoverySends = await runRecoveryPass({
              model: recoveryModel,
              ownerName: config.owner.name,
              messages,
              scratch,
              tools: { send_message: sendMessageTool, stay_silent: staySilentTool },
            });
            recovered = true;
            // Record recovery sends in history as send_message tool calls (the same
            // shape the main loop persists), so the next turn's context reinforces
            // "speaking == send_message".
            parts = [
              ...parts,
              ...recoverySends.map((text, i) => sendMessagePart(text, `recovery-${i}`)),
            ];
            delivered = classifyDelivery(counter.count, scratch, silence.silent);
          } catch (err) {
            log.error('recovery pass failed', { threadId: event.threadId, err: String(err) });
          }
        }
        projection = [scratch, ...extractSends(parts)].filter(Boolean).join('\n');
      }

      // One row per turn (D-MG9): persist the assembled UIMessage payload (rich,
      // for replay) + a flattened text projection (scratch + delivered sends, for
      // recall), with usage/delivery metadata. Skip a wholly empty turn.
      if (assistant && parts.length > 0) {
        const enriched: UIMessage = {
          ...assistant,
          parts,
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
            recovered,
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
        recovered,
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

/** Compact one-line preview of a tool input/result/text for the live step trace. */
function previewArg(v: unknown, max = 140): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
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
  recovered: boolean,
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
    recovered,
    tokensIn: usage.inputTokens ?? null,
    tokensOut: usage.outputTokens ?? null,
    cachedIn: usage.inputTokenDetails?.cacheReadTokens ?? null,
    cacheWriteIn: usage.inputTokenDetails?.cacheWriteTokens ?? null,
    ms,
  });
}
