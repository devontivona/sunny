import { tool } from 'ai';
import type { Gateway } from '../../gateway/types.js';
import { SEND_MESSAGE_SPEC } from './sendMessageSpec.js';

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
    ...SEND_MESSAGE_SPEC,
    execute: async ({ text, image }) => {
      // Deliver only — the conversational loop persists the whole turn as one
      // UIMessage record afterward (D-MG9), so we don't persist per bubble here.
      const result = await gateway.send(
        threadId,
        { text, ...(image ? { attachment: { pathOrUrl: image } } : {}) },
        { persist: false },
      );
      counter.count += 1;
      // Return the media outcome so the persisted turn carries a durable,
      // renderable ref for the dashboard (D-MM5/9). Plain string when no image.
      return result?.media ? { status: 'delivered', media: result.media } : 'delivered';
    },
  });
}
