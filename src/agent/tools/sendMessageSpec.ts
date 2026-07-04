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

/**
 * Text delivery mode's outbound-image tool (text-delivery migration, Phase 4). In text
 * mode the reply is plain text, so images need their own verb; tool mode keeps
 * send_message's "image" param instead. Executes over the SAME memoized send step as
 * every other outbound (the attachment path), so a replay never re-sends.
 */
export const SEND_IMAGE_SPEC = {
  description:
    'Send ONE image to the user as an iMessage. Pass the local file path of an image you ' +
    'produced, or a public URL — never raw bytes. An optional short caption rides along in ' +
    'the same message. To send several images, call this once per image. Your reply text is ' +
    'still delivered separately — do not repeat the caption there.',
  inputSchema: z.object({
    pathOrUrl: z
      .string()
      .min(1)
      .describe('Local file path or public URL of the single image to send.'),
    caption: z.string().optional().describe('Optional short caption delivered with the image.'),
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
