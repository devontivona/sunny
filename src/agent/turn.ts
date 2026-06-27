import { readFileSync } from 'node:fs';
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import type { StoredMessage } from '../gateway/store.js';
import {
  MEDIA,
  dataUrl,
  isHeic,
  modelIngestKind,
  prepareImageForModel,
  type AttachmentRef,
  type PreparedImage,
} from '../gateway/media.js';
import { groupSpeakerPrefix } from './delivery.js';

/**
 * Stored-row → model-message conversion + inbound media resolution (D-MG9 / D-MM3).
 *
 * The side-effect-FREE delivery helpers (classification, steer folding, the persisted
 * turn-record builder) live in `delivery.ts` so they stay Node-free and sandbox-safe
 * for the durable workflow; they are re-exported here so existing `./turn.js` imports
 * keep working. The functions that remain in this module read the filesystem (inbound
 * media), so this module is NOT safe to import from workflow/orchestrator code.
 */
export {
  buildTurnRecord,
  calledStaySilent,
  classifyDelivery,
  extractScratch,
  extractSends,
  groupSpeakerPrefix,
  sendMessagePart,
  splitBubbles,
  steerMessageText,
  trimTrailingNonUser,
  usageOf,
  type Delivery,
  type TurnUsage,
} from './delivery.js';

/**
 * Convert the stored recent window (D-MG9) into model messages. Each row carries a
 * `UIMessage` payload — the real turn (scratch + tool calls incl. every
 * `send_message`) — so the converted history reflects what actually happened.
 * Legacy pre-D-MG9 rows (no payload) get a minimal reconstruction.
 */
export interface MediaResolveOptions {
  /** Injectable byte reader (tests pass a fake; production reads from disk). */
  readFile?: (path: string) => Buffer;
  /** Injectable image preparer (tests fake it; production downscales via ImageMagick). */
  prepareImage?: (bytes: Buffer, mediaType: string) => PreparedImage | null;
  maxInlineCount?: number;
  maxInlineBytes?: number;
}

export function toModelMessages(
  window: StoredMessage[],
  isGroup: boolean,
  opts: MediaResolveOptions = {},
): Promise<ModelMessage[]> {
  const ui = window.map((row) =>
    stripReasoning(resolveMedia(rowToUIMessage(row, isGroup), opts)),
  );
  return convertToModelMessages(ui, { ignoreIncompleteToolCalls: true });
}

/**
 * Drop `reasoning` (extended-thinking) parts from a stored message before it is replayed
 * as history. The durable agent's `collectUIMessages` persists thinking blocks; re-sending
 * them in a later turn's prompt is REJECTED by Anthropic ("`thinking`/`redacted_thinking`
 * blocks in the latest assistant message cannot be modified"). Thinking is private (D-MG8)
 * and only meaningful within its own generation, so history carries none — the live turn
 * manages its current-turn thinking itself. Also drops `step-start` UI markers (model-irrelevant).
 */
function stripReasoning(msg: Omit<UIMessage, 'id'>): Omit<UIMessage, 'id'> {
  if (!msg.parts.some((p) => p.type === 'reasoning' || p.type === 'step-start')) return msg;
  return { ...msg, parts: msg.parts.filter((p) => p.type !== 'reasoning' && p.type !== 'step-start') };
}

/**
 * Resolve a message's persisted media refs to model content (D-MM3). On user
 * messages each `data-attachment` part becomes, best-effort: an inlined file part
 * for an ingestible image/PDF, or a text note (`[attachment: …, saved at …]`) for
 * anything the model can't ingest, an over-cap/over-size item, or one that failed
 * to save — nothing is silently dropped. Non-user messages keep no media parts
 * (outbound media is recorded in the send tool's output, not re-fed to the model).
 */
function resolveMedia(
  msg: Omit<UIMessage, 'id'>,
  opts: MediaResolveOptions,
): Omit<UIMessage, 'id'> {
  const hasAttachment = msg.parts.some((p) => p.type === 'data-attachment');
  if (!hasAttachment) return msg;
  if (msg.role !== 'user') {
    return { ...msg, parts: msg.parts.filter((p) => p.type !== 'data-attachment') };
  }
  return { ...msg, parts: resolveInboundMediaParts(msg.parts, opts) };
}

export function resolveInboundMediaParts(
  parts: UIMessage['parts'],
  opts: MediaResolveOptions = {},
): UIMessage['parts'] {
  const read = opts.readFile ?? ((p: string) => readFileSync(p));
  const prepare = opts.prepareImage ?? prepareImageForModel;
  const maxCount = opts.maxInlineCount ?? MEDIA.maxInlineCount;
  const maxBytes = opts.maxInlineBytes ?? MEDIA.maxInlineBytes;
  let inlined = 0;
  const out: UIMessage['parts'] = [];
  for (const part of parts) {
    if (part.type !== 'data-attachment') {
      out.push(part);
      continue;
    }
    const ref = (part as { data?: AttachmentRef }).data;
    if (!ref) continue;
    out.push(attachmentToPart(ref, { read, prepare, maxBytes, atCap: inlined >= maxCount }));
    if (out[out.length - 1]?.type === 'file') inlined++;
  }
  return out;
}

function note(text: string): UIMessage['parts'][number] {
  return { type: 'text', text } as UIMessage['parts'][number];
}

function filePart(mediaType: string, name: string, bytes: Buffer): UIMessage['parts'][number] {
  return {
    type: 'file',
    mediaType,
    filename: name,
    url: dataUrl(bytes, mediaType),
  } as UIMessage['parts'][number];
}

function attachmentToPart(
  ref: AttachmentRef,
  ctx: {
    read: (p: string) => Buffer;
    prepare: (bytes: Buffer, mediaType: string) => PreparedImage | null;
    maxBytes: number;
    atCap: boolean;
  },
): UIMessage['parts'][number] {
  const at = ref.path ? `, saved at ${ref.path}` : '';
  const head = `[attachment: ${ref.name} (${ref.mediaType})`;
  if (ref.error || !ref.path)
    return note(`${head} — could not be saved: ${ref.error ?? 'no file'}]`);
  if (ctx.atCap) return note(`${head}${at} — not inlined (attachment limit reached)]`);

  // Best-effort by type (D-MM3): images (incl. HEIC) are downscaled + re-encoded;
  // PDFs inline as documents; everything else degrades to a saved-file note.
  const ingest = modelIngestKind(ref.mediaType);
  const image = ingest === 'image' || isHeic(ref.mediaType);
  if (!ingest && !image) return note(`${head}${at}]`);

  let bytes: Buffer;
  try {
    bytes = ctx.read(ref.path);
  } catch {
    return note(`${head}${at} — could not be read]`);
  }

  if (ingest === 'document') {
    // PDF — inline as-is (don't recompress documents).
    if (bytes.length > ctx.maxBytes)
      return note(`${head}${at} — too large to inline (${bytes.length} bytes)]`);
    return filePart(ref.mediaType, ref.name, bytes);
  }

  // Image: downscale + re-encode (transcodes HEIC, shrinks large photos).
  const prepared = ctx.prepare(bytes, ref.mediaType);
  if (!prepared) return note(`${head}${at} — could not convert to a viewable image]`);
  if (prepared.bytes.length > ctx.maxBytes)
    return note(`${head}${at} — too large to inline (${prepared.bytes.length} bytes)]`);
  return filePart(prepared.mediaType, ref.name, prepared.bytes);
}

export function rowToUIMessage(row: StoredMessage, isGroup: boolean): Omit<UIMessage, 'id'> {
  if (row.payload && typeof row.payload === 'object') {
    const msg = row.payload as UIMessage;
    if (isGroup && msg.role === 'user' && row.senderName) return prefixUserMessage(msg, row);
    return msg;
  }
  // Legacy row (pre-D-MG9): minimal reconstruction.
  if (row.role === 'user') {
    const text = isGroup ? groupSpeakerPrefix(row.senderName, row.isOwner) + row.text : row.text;
    return { role: 'user', parts: [{ type: 'text', text }] };
  }
  return { role: 'assistant', parts: [{ type: 'text', text: row.text }] };
}

/** Prefix the speaker onto a group user message's text part(s) (R1). */
export function prefixUserMessage(msg: UIMessage, row: StoredMessage): UIMessage {
  const prefix = groupSpeakerPrefix(row.senderName, row.isOwner);
  return {
    ...msg,
    parts: msg.parts.map((p) => (p.type === 'text' ? { ...p, text: prefix + p.text } : p)),
  };
}
