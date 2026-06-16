import { ToolLoopAgent, stepCountIs, type ModelMessage } from 'ai';
import type { SunnyConfig } from '../config/index.js';
import type { ChannelEvent, Gateway } from '../gateway/types.js';
import type { ConversationStore, StoredMessage } from '../gateway/store.js';
import { logger } from '../logger.js';
import { getModel, anthropicProviderOptions } from './model.js';
import { buildSystemPrompt, FORGOT_TO_SEND_NUDGE } from './prompt.js';
import { createSendMessageTool, type SendCounter } from './tools/sendMessage.js';

const log = logger('agent:loop');

export interface AgentRunnerDeps {
  config: SunnyConfig;
  store: ConversationStore;
  gateway: Gateway;
}

/**
 * In-process conversational turn (durable-execution Tier 1, D-DE1; task 2.5).
 *
 * Reads the recent window from Sunny's own store, runs an Opus `ToolLoopAgent`
 * with adaptive thinking, and talks to the user ONLY via the `send_message`
 * tool (D-MG8). Raw model text is never delivered.
 *
 * Unintended-silence guard (D-MG8): if a turn produces no `send_message`, a DM
 * is re-run with `toolChoice` forced to `send_message` (thinking disabled, since
 * Anthropic disallows forced tool choice with extended thinking) so a reply is
 * guaranteed; a group gets a soft nudge and may legitimately stay silent.
 *
 * → Milestone B: text Sunny, get a real Opus reply.
 */
export function createAgentRunner(deps: AgentRunnerDeps) {
  const { config, store, gateway } = deps;
  const instructions = buildSystemPrompt(config);

  return async function runTurn(event: ChannelEvent): Promise<void> {
    // Typing indicator on turn start (D-MG8, D-DE3) — degrades to no-op if unsupported.
    await gateway.startTyping(event.threadId);

    const messages = toModelMessages(store.recentWindow(event.threadId), event.isGroup);
    const counter: SendCounter = { count: 0 };
    const tools = { send_message: createSendMessageTool(gateway, event.threadId, counter) };
    const agent = new ToolLoopAgent({
      model: getModel(config),
      instructions,
      tools,
      stopWhen: stepCountIs(20),
      providerOptions: anthropicProviderOptions(config),
    });

    try {
      await agent.generate({ prompt: messages });

      if (counter.count === 0) {
        if (event.isGroup) {
          // Group: a reply may not be expected. Soft nudge once; silence is OK.
          log.debug('no send in group turn; soft nudge', { threadId: event.threadId });
          await agent.generate({
            prompt: [...messages, { role: 'user', content: FORGOT_TO_SEND_NUDGE }],
          });
          if (counter.count === 0) {
            log.info('group turn ended in deliberate silence', { threadId: event.threadId });
          }
        } else {
          // DM: a reply is expected. Force send_message via toolChoice. Anthropic
          // forbids forced tool choice with extended thinking, so disable it here.
          log.debug('no send in DM turn; forcing a reply', { threadId: event.threadId });
          const forced = new ToolLoopAgent({
            model: getModel(config),
            instructions,
            tools,
            stopWhen: stepCountIs(1),
            toolChoice: { type: 'tool', toolName: 'send_message' },
            providerOptions: { anthropic: { thinking: { type: 'disabled' as const } } },
          });
          await forced.generate({ prompt: messages });
          if (counter.count === 0) {
            log.error('forced reply still produced no send', { threadId: event.threadId });
          }
        }
      }
    } catch (err) {
      log.error('agent turn failed', { threadId: event.threadId, err: String(err) });
      await gateway.send(event.threadId, {
        text: 'Sorry — I hit an error handling that. Mind trying again?',
      });
    }
  };
}

/**
 * Build the model prompt from the stored recent window. Inbound → user,
 * outbound → assistant. In groups, prefix the speaker so the model can follow
 * who said what (it answers everyone but only acts for the owner — R1).
 */
function toModelMessages(window: StoredMessage[], isGroup: boolean): ModelMessage[] {
  return window.map((m): ModelMessage => {
    if (m.role === 'assistant') {
      return { role: 'assistant', content: m.text };
    }
    const content =
      isGroup && m.senderName ? `${m.senderName}${m.isOwner ? ' (owner)' : ''}: ${m.text}` : m.text;
    return { role: 'user', content };
  });
}
