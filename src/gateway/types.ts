/**
 * The normalized Gateway seam (messaging-gateway D-MG1/D-MG3, task 2.1).
 *
 * The agent core speaks ONLY this interface — it never imports `chat`,
 * `chat-adapter-sendblue`, or any transport type. Each channel is a pluggable
 * driver behind this seam, so adding a channel (Telegram, email, CLI) or
 * swapping the iMessage transport (Sendblue, local macOS) requires no agent
 * changes.
 */

export type ChannelId = string;

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Normalized inbound event (D-MG3). Channel-agnostic; the agent never sees
 * iMessage-specific shapes. `isOwner` is tagged by sender authorization
 * (D-MG6 / R1) — only owner messages may trigger high-consequence actions
 * (enforced from Phase 4 onward).
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
}

/** Outbound payload (D-MG3). Attachments/reactions are added as channels gain them. */
export interface OutboundMessage {
  text: string;
}

/** Per-channel capability flags for feature-detection + graceful degradation (D-MG3). */
export interface ChannelCapabilities {
  reactions: boolean;
  readReceipts: boolean;
  typing: boolean;
  groups: boolean;
  /** Restart-durable, initiated group messaging — supported on Sendblue (D-MG5). */
  proactiveGroup: boolean;
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
  send(threadId: string, message: OutboundMessage, opts?: { persist?: boolean }): Promise<void>;

  /** Show a typing indicator on a thread (no-op if unsupported). */
  startTyping(threadId: string): Promise<void>;

  /** Initialize the underlying transport. */
  start(): Promise<void>;

  /** Handle an inbound HTTP webhook request from the transport. */
  handleWebhook(request: Request): Promise<Response>;
}
