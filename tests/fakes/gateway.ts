import type {
  ChannelCapabilities,
  ChannelEvent,
  Gateway,
  InboundHandler,
  OutboundMessage,
} from '../../src/gateway/types.js';

/** One captured outbound send, for assertion. */
export interface SentMessage {
  threadId: string;
  text: string;
  /** The persist flag the caller passed (the loop sends with `persist: false`). */
  persist: boolean;
}

/**
 * In-memory `Gateway` driver for tests + evals (design D3 / task 2.2).
 *
 * Implements the normalized `Gateway` seam — the same interface the agent core
 * depends on — recording every outbound `send` for assertion and exposing
 * `injectInbound` to feed the registered handler. Nothing touches Sendblue, so
 * tests are stable across transport changes and the same fake serves both lanes.
 */
export class FakeGateway implements Gateway {
  readonly channel = 'imessage';
  readonly capabilities: ChannelCapabilities = {
    reactions: true,
    readReceipts: false,
    typing: true,
    groups: true,
    proactiveGroup: true,
  };

  /** Every outbound send, in order. */
  readonly sent: SentMessage[] = [];
  /** Threads on which `startTyping` was called, in order. */
  readonly typingStarted: string[] = [];

  private handler: InboundHandler | null = null;

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  /** Feed an inbound event to the registered handler (the test's "user message"). */
  async injectInbound(event: ChannelEvent): Promise<void> {
    if (!this.handler) throw new Error('FakeGateway: no inbound handler registered');
    await this.handler(event);
  }

  async send(
    threadId: string,
    message: OutboundMessage,
    opts?: { persist?: boolean },
  ): Promise<void> {
    this.sent.push({ threadId, text: message.text, persist: opts?.persist ?? true });
  }

  async startTyping(threadId: string): Promise<void> {
    this.typingStarted.push(threadId);
  }

  async start(): Promise<void> {
    // no-op: nothing to initialize
  }

  async handleWebhook(): Promise<Response> {
    return new Response('ok', { status: 200 });
  }

  // --- assertion helpers ---------------------------------------------------

  /** The text of every outbound send (for `sendCount` / content assertions). */
  texts(): string[] {
    return this.sent.map((m) => m.text);
  }

  /** Number of outbound sends — the eval `sendCount`. */
  get sendCount(): number {
    return this.sent.length;
  }

  /** Clear the captured buffers (e.g. between turns in a multi-turn case). */
  reset(): void {
    this.sent.length = 0;
    this.typingStarted.length = 0;
  }
}
