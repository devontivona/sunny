import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  MEDIA,
  contentTypeForName,
  isGenericBinaryType,
  prepareImageForModel,
  sniffMediaType,
  waitForStableFile,
  MediaNotReadyError,
} from '../../gateway/media.js';
import type { InlineImagePreview } from './imageToolOutput.js';
import type { ViewImageOutput } from './viewImageSpec.js';

/**
 * Host-side half of the image tool results (image-send-integrity, 2026-07-10):
 * read + downscale an image into an `InlineImagePreview` the model can ingest.
 * Reuses the inbound pipeline (`prepareImageForModel`: EXIF orient, HEIC
 * transcode, JPEG re-encode) at a smaller edge cap — self-review needs to judge
 * composition/artifacts, not read microtext, and preview tokens ride in EVERY
 * image tool result. Imported only via dynamic import inside `'use step'`
 * bodies (this module touches fs, so it is NOT workflow-VM safe).
 */

/** Downscale cap for self-review previews (the inbound cap is 2000). */
const PREVIEW_MAX_EDGE = 1024;

/** Downscale bytes into an inlineable preview; null when not convertible. */
export function buildImagePreview(bytes: Buffer, declaredType: string): InlineImagePreview | null {
  const mediaType = isGenericBinaryType(declaredType)
    ? sniffMediaType(bytes, declaredType)
    : declaredType;
  const prepared = prepareImageForModel(bytes, mediaType, { maxEdge: PREVIEW_MAX_EDGE });
  if (!prepared || prepared.bytes.length > MEDIA.maxInlineBytes) return null;
  return { data: prepared.bytes.toString('base64'), mediaType: prepared.mediaType };
}

/** Best-effort preview of a file already persisted on disk (send_image echo). */
export function previewFromFile(path: string, declaredType?: string): InlineImagePreview | null {
  try {
    const bytes = readFileSync(path);
    return buildImagePreview(bytes, declaredType ?? contentTypeForName(path));
  } catch {
    return null;
  }
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** `view_image` execution body: wait briefly for an in-flight write, validate the
 *  bytes are a real image, and return the serializable output (never throws). */
export async function readImageForViewing(
  path: string,
  opts: { timeoutMs?: number } = {},
): Promise<ViewImageOutput> {
  const full = expandHome(path);
  let bytes: Buffer;
  try {
    // Shorter grace than the send path — a view usually follows its write closely.
    bytes = await waitForStableFile(full, { timeoutMs: opts.timeoutMs ?? 5_000 });
  } catch (err) {
    if (err instanceof MediaNotReadyError) return { status: 'error', error: err.message };
    return { status: 'error', error: String(err) };
  }
  const declared = contentTypeForName(full);
  const mediaType = declared.startsWith('image/') ? declared : sniffMediaType(bytes, declared);
  if (!mediaType.startsWith('image/')) {
    return {
      status: 'error',
      error:
        `"${path}" is not an image (${mediaType}) — view_image only opens images. ` +
        `Use file_read for text files.`,
    };
  }
  const preview = buildImagePreview(bytes, mediaType);
  if (!preview) {
    return { status: 'error', error: `could not convert "${path}" into a viewable image.` };
  }
  return { status: 'ok', path: full, mediaType, size: bytes.length, preview };
}
