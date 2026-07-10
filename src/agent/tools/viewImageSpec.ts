import { z } from 'zod';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { imageContent, PREVIEW_STRIPPED_NOTE, type InlineImagePreview } from './imageToolOutput.js';

/**
 * The `view_image` tool DEFINITION (image-send-integrity, 2026-07-10): look at a local
 * image file — the model's only way to SEE an image it generated or edited (file_read
 * is text-only, and outbound media is never re-fed from history). Execution lives in
 * the conversation workflow (`viewImageStep` → host-side `readImageForViewing`); this
 * module stays pure/Node-free for the workflow VM.
 */

/** What `viewImageStep` returns (serializable; journaled by the WDK). */
export type ViewImageOutput =
  | {
      status: 'ok';
      path: string;
      mediaType: string;
      /** Raw file size in bytes (the preview below is a downscaled copy). */
      size: number;
      /** Turn-ephemeral downscaled copy (stripped at persist). */
      preview?: InlineImagePreview;
      /** Set at the persist boundary in place of `preview` (see delivery.ts). */
      previewStripped?: boolean;
    }
  | { status: 'error'; error: string };

/** Map the step output to what the model sees (pure — runs inside the workflow VM). */
export function viewImageToModelOutput({ output }: { output: ViewImageOutput }): ToolResultOutput {
  if (output.status !== 'ok') return { type: 'error-text', value: output.error };
  if (output.preview) {
    return imageContent(
      `${output.path} (${output.mediaType}, ${output.size} bytes) — the image follows:`,
      output.preview,
    );
  }
  return {
    type: 'text',
    value: `${output.path} (${output.mediaType}, ${output.size} bytes)${
      output.previewStripped ? ` [${PREVIEW_STRIPPED_NOTE}]` : ''
    }`,
  };
}

export const VIEW_IMAGE_SPEC = {
  description:
    'Look at a local image file: the image is returned as real vision content, so you ' +
    'actually SEE it (your file_read tool cannot open images). Use it to check any image ' +
    'you generate or edit BEFORE sending it or publishing it to a site — composition, ' +
    'artifacts, backgrounds, crops — and to re-view an image you sent earlier (its saved ' +
    'path is in that send_image result). Waits a few seconds for a file that is still ' +
    'being written, then errors honestly if there is no finished image at the path.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Local file path of the image to view.'),
  }),
  toModelOutput: viewImageToModelOutput,
} as const;
