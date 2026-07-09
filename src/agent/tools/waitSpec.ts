import { z } from 'zod';

/**
 * The `wait` tool SPEC (multipart-coalesce, model-level half — 2026-07-09). The router's
 * quiet window coalesces TRANSPORT splits (webhooks 0.5–5s apart), but a human often sends
 * "put this on my calendar" and then takes 10–20 seconds to paste the link — no transport
 * window can bridge that without making every reply feel dead. The MODEL can: it sees the
 * unresolved forward reference and waits in-turn. The sleep is a durable step; whatever
 * arrives while waiting is folded into the turn's next step by the standard steering fold
 * (`loadSteers` — text AND media, as real image parts), so the turn answers once, with the
 * full send in view. Node-free (zod only), matching the other tool specs.
 */
export const WAIT_SPEC = {
  description:
    'Pause this turn and let anything the user is still sending catch up: messages that ' +
    'arrive while you wait are folded into your context right after the wait, exactly like ' +
    'messages you can already see. USE THIS when the latest message references content that ' +
    'has not arrived yet — "put this on my calendar", "check out this link", "sending you a ' +
    'pic" — and nothing in the thread matches: the rest of the send is usually seconds away. ' +
    'NEVER ask what they mean before waiting. If nothing new arrives after one or two waits, ' +
    'reply to what you have (a brief note that you are ready for the link/photo beats a ' +
    '"what do you mean?").',
  inputSchema: z.object({
    seconds: z.number().optional().describe('How long to wait, in seconds (default 10, max 30).'),
  }),
} as const;
