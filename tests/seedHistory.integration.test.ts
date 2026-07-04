import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { createTestDb } from './db.js';
import { ConversationStore } from '../src/gateway/store.js';
import { toModelMessages } from '../src/agent/turn.js';
import { makeAssistantTurnPayload, makeChannelEvent, OWNER_THREAD } from './factories.js';

/**
 * Seed-audit invariant (2026-07): assistant history seeded through the store —
 * the exact path the eval harness uses — must replay to the model as
 * `send_message` TOOL CALLS, never as bare assistant text. Bare-text assistant
 * turns in the window would show the model an in-context precedent of replying
 * in plain text: the very failure mode the elicitation evals measure. This pins
 * `appendOutbound`'s D-MG9 send payload and the rich `appendTurn` seed shape.
 */

function contentParts(m: ModelMessage): Array<{ type: string; toolName?: string; text?: string }> {
  return typeof m.content === 'string'
    ? [{ type: 'text', text: m.content }]
    : (m.content as Array<{ type: string; toolName?: string; text?: string }>);
}

describe('seeded assistant history fidelity', () => {
  it('appendOutbound seeds replay as send_message tool calls, never bare text', async () => {
    const tdb = await createTestDb();
    try {
      const store = new ConversationStore(tdb.db, 30);
      await store.appendInbound(makeChannelEvent({ text: 'remind me to call mom at 6' }));
      await store.appendOutbound(OWNER_THREAD, 'seed-1', "Done — I'll remind you at 6pm.");

      const window = await store.recentWindow(OWNER_THREAD);
      const messages = await toModelMessages(window, false);
      const assistants = messages.filter((m) => m.role === 'assistant');
      expect(assistants).toHaveLength(1);

      const parts = contentParts(assistants[0]!);
      expect(parts.some((p) => p.type === 'tool-call' && p.toolName === 'send_message')).toBe(
        true,
      );
      // The delivered text lives in the tool call's input, not in an assistant text part.
      expect(parts.some((p) => p.type === 'text' && p.text?.includes('remind you'))).toBe(false);
      // The paired tool result survives conversion (a dangling tool call would be dropped).
      expect(messages.some((m) => m.role === 'tool')).toBe(true);
    } finally {
      await tdb.teardown();
    }
  });

  it('rich seeds (scratch + multiple sends) replay the full D-MG9 turn shape', async () => {
    const tdb = await createTestDb();
    try {
      const store = new ConversationStore(tdb.db, 30);
      await store.appendInbound(makeChannelEvent({ text: 'plan my trip' }));
      const sends = ['Love it — where to?', 'And when are you leaving?'];
      await store.appendTurn(
        OWNER_THREAD,
        makeAssistantTurnPayload({ scratch: 'options weighed: beach vs city', sends }),
        sends.join('\n'),
      );

      const window = await store.recentWindow(OWNER_THREAD);
      const messages = await toModelMessages(window, false);
      const assistants = messages.filter((m) => m.role === 'assistant');
      const parts = assistants.flatMap(contentParts);

      const sendCalls = parts.filter((p) => p.type === 'tool-call' && p.toolName === 'send_message');
      expect(sendCalls).toHaveLength(2);
      // Scratch replays as (private) assistant text alongside the tool calls.
      expect(parts.some((p) => p.type === 'text' && p.text?.includes('options weighed'))).toBe(
        true,
      );
    } finally {
      await tdb.teardown();
    }
  });
});
