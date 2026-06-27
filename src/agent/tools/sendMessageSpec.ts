import { z } from 'zod';

/**
 * The `send_message` / `stay_silent` tool DEFINITIONS (description + input schema),
 * separated from execution so both the in-process loop (`tools/sendMessage.ts`,
 * `tools/staySilent.ts`) and the durable conversational workflow
 * (`workflows/conversation.ts`) bind the IDENTICAL prompt-shaping text and schema —
 * these descriptions are load-bearing for the D-MG8 output model, so the two tiers
 * must never drift. Mirrors the `*Specs.ts` split already used for bash/memory.
 *
 * Side-effecting `execute` is supplied per-tier (an in-process `gateway.send`, or a
 * memoized `'use step'` REST send in the workflow); only the contract lives here.
 */
export const SEND_MESSAGE_SPEC = {
  description:
    'Send a message to the user. This is the ONLY way to say something to them — ' +
    'your thinking and any other text you produce are private and never delivered. ' +
    'You may call this multiple times in one turn (each becomes a separate message), ' +
    'and calling it does NOT end your turn. If you have nothing useful to say, simply ' +
    'do not call it. Optionally attach ONE image by passing its local file path (a file ' +
    'you produced) or a public URL in "image" — to send several images, send several ' +
    'messages. Pass the path or URL, never the raw bytes.',
  inputSchema: z.object({
    text: z.string().min(1).describe('The exact text to deliver to the user.'),
    image: z
      .string()
      .optional()
      .describe('Optional: a local file path or URL of a single image to attach.'),
  }),
} as const;

export const STAY_SILENT_SPEC = {
  description:
    'Deliberately say nothing this turn. Call this when the latest message just closes the ' +
    'loop — a 👍 or reaction, "ok", "thanks", "got it", "sounds good" — and there is ' +
    'genuinely nothing useful to add. Calling stay_silent IS how you choose silence: it ends ' +
    'the turn with no message delivered. Do not call it if there is something worth saying — ' +
    'use send_message for that.',
  inputSchema: z.object({}),
} as const;
