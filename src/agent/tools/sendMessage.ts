import { tool } from 'ai';
import { z } from 'zod';
import type { Gateway } from '../../gateway/types.js';

/** Mutable counter so the runner can detect whether the agent spoke (D-MG8 guard). */
export interface SendCounter {
  count: number;
}

/**
 * The `send_message` tool (messaging-gateway D-MG8, task 2.5a).
 *
 * This is the ONLY way Sunny speaks to the user — raw model text and reasoning
 * are private. It may be called multiple times per turn (multi-bubble) and does
 * NOT end the turn (reason → send → keep working → send again). Not calling it
 * means staying silent. Delivery + persistence happen in `gateway.send`.
 */
export function createSendMessageTool(gateway: Gateway, threadId: string, counter: SendCounter) {
  return tool({
    description:
      'Send a message to the user. This is the ONLY way to say something to them — ' +
      'your thinking and any other text you produce are private and never delivered. ' +
      'You may call this multiple times in one turn (each becomes a separate message), ' +
      'and calling it does NOT end your turn. If you have nothing useful to say, simply ' +
      'do not call it.',
    inputSchema: z.object({
      text: z.string().min(1).describe('The exact text to deliver to the user.'),
    }),
    execute: async ({ text }) => {
      // Deliver only — the conversational loop persists the whole turn as one
      // UIMessage record afterward (D-MG9), so we don't persist per bubble here.
      await gateway.send(threadId, { text }, { persist: false });
      counter.count += 1;
      return 'delivered';
    },
  });
}
