import { z } from 'zod';

/**
 * Outbound-messaging tool DEFINITIONS (description + input schema), separated from
 * execution (the `*Specs.ts` split used for bash/memory). `SEND_IMAGE_SPEC` is the
 * conversation turn's one media verb (text-as-reply, PR #31). `SEND_MESSAGE_SPEC`
 * remains ONLY as the delegated subagent's report channel (workflows/subagent.ts) —
 * scheduled for retirement by the subagent text-unification proposal.
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

