import { z } from 'zod';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { imageContent, PREVIEW_STRIPPED_NOTE, type InlineImagePreview } from './imageToolOutput.js';

/**
 * The `send_image` tool DEFINITION (description + input schema + result→model mapping),
 * separated from execution (the `*Specs.ts` split used for bash/memory): the conversation
 * turn's one outbound-media verb (text-as-reply, PR #31).
 *
 * Image-send-integrity (2026-07-10): the send now FAILS LOUDLY when the file isn't
 * ready (the gateway waits up to ~10s, then aborts the whole send — no caption-only
 * text), and a successful send echoes the delivered image back as tool-result vision
 * content so the model can verify what the user actually received.
 */

/** What `sendStep` returns for an image send (serializable; journaled by the WDK). */
export type SendImageOutput =
  | {
      status: 'delivered';
      /** The gateway's media outcome (durable path or passthrough URL) — persisted
       *  in the turn payload; the dashboard renders history from it. */
      media: unknown;
      /** Turn-ephemeral downscaled copy of what was sent (stripped at persist). */
      preview?: InlineImagePreview;
      /** Set at the persist boundary in place of `preview` (see delivery.ts). */
      previewStripped?: boolean;
    }
  | { status: 'not_sent'; error: string };

/** Map the step output to what the model sees (invoked by the AI SDK loop; pure —
 *  runs inside the workflow VM). Success shows the delivered image itself. */
export function sendImageToModelOutput({
  output,
}: {
  output: SendImageOutput | string;
}): ToolResultOutput {
  if (typeof output === 'string') return { type: 'text', value: output }; // legacy rows
  if (output.status !== 'delivered') {
    return { type: 'error-text', value: `IMAGE NOT SENT: ${output.error}` };
  }
  const media = output.media as { name?: string; path?: string; url?: string } | undefined;
  const label = media?.name ?? media?.url ?? 'image';
  // Name the durable copy (or passthrough URL) in the TEXT so it survives the persist
  // boundary (history keeps only the text parts — see `persistableToolOutput`, which
  // also lifts the path back out for dashboard rendering) and a later turn can view it.
  const where = media?.path
    ? `, saved at ${media.path}`
    : media?.url && media.url !== label
      ? `, from ${media.url}`
      : '';
  if (output.preview) {
    return imageContent(
      `Image delivered (${label}${where}). Below is EXACTLY what was sent — verify it is ` +
        `the right image and looks correct; if not, say so honestly and fix it:`,
      output.preview,
    );
  }
  return {
    type: 'text',
    value: `Image delivered (${label}${where}).${
      output.previewStripped ? ` [${PREVIEW_STRIPPED_NOTE}]` : ''
    }`,
  };
}

export const SEND_IMAGE_SPEC = {
  description:
    'Send ONE image to the user as an iMessage. Pass the local file path of an image you ' +
    'produced, or a public URL — never raw bytes. An optional short caption rides along in ' +
    'the same message. To send several images, call this once per image. Your reply text is ' +
    'still delivered separately — do not repeat the caption there. The send FAILS (nothing ' +
    'is delivered, not even the caption) if the file does not exist or is not a finished ' +
    'image after a ~10s grace, so finish writing the file before calling this. On success ' +
    'the result shows you the delivered image — look at it and confirm it is right.',
  inputSchema: z.object({
    pathOrUrl: z
      .string()
      .min(1)
      .describe('Local file path or public URL of the single image to send.'),
    caption: z.string().optional().describe('Optional short caption delivered with the image.'),
  }),
  toModelOutput: sendImageToModelOutput,
} as const;
