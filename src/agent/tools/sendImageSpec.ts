import { z } from 'zod';

/**
 * The `send_image` tool DEFINITION (description + input schema), separated from execution
 * (the `*Specs.ts` split used for bash/memory): the conversation turn's one outbound-media
 * verb (text-as-reply, PR #31). The last `SEND_MESSAGE_SPEC` consumer (the delegated
 * child's report tool) was retired by the subagent text-unification change — every run
 * profile now speaks in text.
 */
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
