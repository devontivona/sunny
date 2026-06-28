/**
 * The normalized Gateway seam (messaging-gateway D-MG1/D-MG3, task 2.1).
 *
 * The agent core speaks ONLY this interface — it never imports `chat`,
 * `chat-adapter-sendblue`, or any transport type. Each channel is a pluggable
 * driver behind this seam, so adding a channel (Telegram, email, CLI) or
 * swapping the iMessage transport (Sendblue, local macOS) requires no agent
 * changes.
 */

import type { AttachmentKind, OutboundAttachment, OutboundMediaResult } from './media.js';

export type { OutboundAttachment } from './media.js';

export type ChannelId = string;

/**
 * A normalized inbound attachment. Carries enough to RETRIEVE the content, not
 * just metadata (messaging-media D-MM1): `fetchData()` pulls the bytes from the
 * transport (Sendblue media URLs expire, so the gateway calls this promptly), or
 * `data` holds bytes the transport already inlined. Once persisted, replayed
 * attachments are reconstructed from the stored payload without either.
 */
export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  /** Retrieve the bytes (transport-specific). Absent on replayed/persisted refs. */
  fetchData?: () => Promise<Buffer>;
  /** Bytes the transport provided inline (e.g. a `data:` URI). */
  data?: Buffer;
  /** Source URL, if any — informational and may be short-lived. */
  url?: string;
}

/**
 * Normalized inbound event (D-MG3). Channel-agnostic; the agent never sees
 * iMessage-specific shapes. Sender authorization (D-MG6 / multiplayer-family D1)
 * tags the trust tier: `isOwner` (specifically the owner), `isTrusted` (owner OR
 * family), and the resolved `senderRole`. Only `isOwner` is persisted on the
 * message row; `isTrusted`/`senderRole` are derived fresh at turn time from the
 * current roster, so they may be absent on replayed/reconstructed events.
 */
export interface ChannelEvent {
  channel: ChannelId;
  threadId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  attachments: Attachment[];
  timestamp: Date;
  isGroup: boolean;
  isOwner: boolean;
  /** Owner OR family — drives elevated capabilities (multiplayer-family D1). */
  isTrusted?: boolean;
  /** Resolved trust tier of the sender ('owner' | 'family' | null). */
  senderRole?: 'owner' | 'family' | null;
}

/**
 * Outbound payload (D-MG3). `attachment` carries a single optional image
 * (messaging-media D-MM5) — a local path Sunny produced or a URL; the gateway
 * hosts/sends it (or degrades to text, per the channel + thread).
 */
export interface OutboundMessage {
  text: string;
  attachment?: OutboundAttachment;
}

/** What a send did with an attachment, for the caller to record (D-MM5/9). */
export interface SendResult {
  messageId?: string;
  media?: OutboundMediaResult;
}

/** Per-channel capability flags for feature-detection + graceful degradation (D-MG3). */
export interface ChannelCapabilities {
  reactions: boolean;
  readReceipts: boolean;
  typing: boolean;
  groups: boolean;
  /** Restart-durable, initiated group messaging — supported on Sendblue (D-MG5). */
  proactiveGroup: boolean;
  /** Media/attachment send + receive — supported on Sendblue (D-MM7). */
  media: boolean;
}

export type InboundHandler = (event: ChannelEvent) => Promise<void>;

/**
 * A channel driver. The agent core depends on this, not on any transport.
 */
export interface Gateway {
  readonly channel: ChannelId;
  readonly capabilities: ChannelCapabilities;

  /** Register the handler invoked for each authorized inbound message. */
  onInbound(handler: InboundHandler): void;

  /**
   * Deliver a message to a thread. By default it also persists the message to the
   * conversation store (used by proactive/Tier-2 sends). The conversational loop
   * passes `{ persist: false }` because it rolls all of a turn's sends + scratch
   * into a single `UIMessage` turn record itself (D-MG9).
   */
  send(
    threadId: string,
    message: OutboundMessage,
    opts?: { persist?: boolean },
  ): Promise<SendResult>;

  /** Show a typing indicator on a thread (no-op if unsupported). */
  startTyping(threadId: string): Promise<void>;

  /**
   * Clear the typing indicator on a thread (Sendblue typing-v2 `state: 'stop'`). Optional — a
   * driver whose indicator is purely auto-expiring (or that has no stop) omits it. The durable
   * router calls it when a turn ends so "…" disappears immediately instead of lingering for the
   * transport's auto-expiry window. Best-effort: failures are swallowed (the indicator still
   * auto-expires).
   */
  stopTyping?(threadId: string): Promise<void>;

  /**
   * Epoch-ms of the most recent outbound delivery on a thread, or undefined if none this
   * session. Lets a typing driver suppress the indicator right after a message lands (so it
   * doesn't reappear during a turn's post-send housekeeping) — durable-main-loop typing fix.
   */
  lastSentAt?(threadId: string): number | undefined;

  /** Initialize the underlying transport. */
  start(): Promise<void>;

  /** Handle an inbound HTTP webhook request from the transport. */
  handleWebhook(request: Request): Promise<Response>;
}
