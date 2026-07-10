import type { ToolResultOutput } from '@ai-sdk/provider-utils';

/**
 * Pure helpers for image-bearing tool RESULTS (image-send-integrity, 2026-07-10).
 *
 * `send_image` and `view_image` return their image as part of the tool result so
 * the model actually SEES what it produced/sent (it previously had no way to view
 * any image it generated — every "screenshot review" was confabulated). The step
 * output carries a downscaled `preview` (base64); the tool's `toModelOutput` maps
 * it to a media content part, which the Anthropic provider turns into a
 * `tool_result` image block.
 *
 * This module is imported by the durable conversation workflow (sandboxed VM), so
 * it must stay Node-free and pure: the fs/ImageMagick half lives in
 * `imagePreview.ts` (host-side, dynamic-imported inside `'use step'` bodies only).
 */

/** A downscaled, model-ingestible copy of an image, riding in a step output. */
export interface InlineImagePreview {
  /** Base64 image bytes (NOT a data: URL). */
  data: string;
  mediaType: string;
}

/** Note substituted when a persisted row's preview was stripped at the write
 *  boundary (previews are turn-ephemeral; history carries only the file path). */
export const PREVIEW_STRIPPED_NOTE =
  'the image was shown here during the original turn; call view_image on the path to see it again';

/** Content-part list for a tool result that carries an image preview. */
export function imageContent(lead: string, preview: InlineImagePreview): ToolResultOutput {
  return {
    type: 'content',
    value: [
      { type: 'text', text: lead },
      { type: 'file', data: { type: 'data', data: preview.data }, mediaType: preview.mediaType },
    ],
  };
}
