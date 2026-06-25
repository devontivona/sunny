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

/**
 * Pure turn helpers extracted from `loop.ts` (testability refactor D13, task 3.1).
 *
 * These hold the D-MG8 delivery logic and the D-MG9 stored-row → model-message
 * conversion as side-effect-free functions so they can be unit-tested directly,
 * without standing up the model, gateway, or DB. `runTurn` calls them; behavior
 * is unchanged.
 */

/** How a turn's reply reached (or didn't reach) the user (D-MG8). */
export type Delivery = 'send_message' | 'fallback_text' | 'silence';

/**
 * Classify how a turn was delivered from three observable signals: how many times
 * `send_message` was called, whether the model affirmatively called `stay_silent`,
 * and whether any private scratch text exists.
 *
 * - `send_message` — the intended path: the model spoke via the tool.
 * - `silence` — a deliberate, valid choice: the model called `stay_silent`, OR it
 *   produced nothing at all (no send, no scratch).
 * - `fallback_text` — an elicitation MISS: the model wrote private scratch but
 *   called NEITHER `send_message` nor `stay_silent`. This is what triggers the
 *   recovery pass (and, if recovery is somehow skipped, what gets logged as the
 *   regression signal). Raw scratch is never delivered as-is.
 *
 * From the user's perspective `silence` and an unrecovered `fallback_text` both
 * mean "no message arrived"; they are kept distinct purely as telemetry.
 */
export function classifyDelivery(sendCount: number, scratch: string, staySilent = false): Delivery {
  if (sendCount > 0) return 'send_message';
  if (staySilent) return 'silence';
  if (scratch) return 'fallback_text';
  return 'silence';
}

/**
 * Trim trailing non-user messages (assistant + tool) back to the last user
 * message. Anthropic rejects a prompt that ends on an assistant message, and the
 * stored window is insertion-ordered (D-MG9), so a turn record can leave trailing
 * assistant/tool messages. Returns a new array; does not mutate the input.
 */
export function trimTrailingNonUser(messages: ModelMessage[]): ModelMessage[] {
  const out = messages.slice();
  while (out.length > 0 && out[out.length - 1]?.role !== 'user') {
    out.pop();
  }
  return out;
}

/** The private scratchpad text of a turn: all `text` parts, joined and trimmed. */
export function extractScratch(parts: UIMessage['parts']): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * Build a `tool-send_message` UIMessage part for a delivered message. Used to
 * record a recovery-pass send (which happens in a separate model call) into the
 * turn's history as a `send_message` tool call — the same shape the main loop
 * persists — so the next turn's context reinforces "speaking == send_message".
 */
export function sendMessagePart(text: string, toolCallId: string): UIMessage['parts'][number] {
  return {
    type: 'tool-send_message',
    toolCallId,
    state: 'output-available',
    input: { text },
    output: 'delivered',
  } as UIMessage['parts'][number];
}

/**
 * Split a reply into iMessage bubbles on blank lines (text delivery mode). A reply
 * with no blank line is one bubble; empty/whitespace yields no bubbles.
 */
export function splitBubbles(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The delivered messages of a turn: the `text` input of each `send_message` call. */
export function extractSends(parts: UIMessage['parts']): string[] {
  return parts
    .filter((p) => p.type === 'tool-send_message')
    .map((p) => (p as { input?: { text?: string } }).input?.text)
    .filter((t): t is string => !!t);
}

/**
 * Speaker prefix for a group user message (R1) — e.g. `Devon (owner): ` — so the
 * model can follow who said what. Empty string when there's no sender name.
 */
export function groupSpeakerPrefix(senderName: string | undefined, isOwner: boolean): string {
  if (!senderName) return '';
  return `${senderName}${isOwner ? ' (owner)' : ''}: `;
}

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
  const ui = window.map((row) => resolveMedia(rowToUIMessage(row, isGroup), opts));
  return convertToModelMessages(ui, { ignoreIncompleteToolCalls: true });
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
