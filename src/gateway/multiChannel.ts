import type {
  ChannelCapabilities,
  Gateway,
  InboundHandler,
  OutboundMessage,
  SendResult,
} from './types.js';
import type { LoopbackGateway } from './loopback.js';

/**
 * Runs multiple channel drivers at once and routes by thread (durable-main-loop test channel).
 *
 * The agent core, router, and durable turn-runs all deliver through one `getRuntime().gateway`,
 * keyed by `threadId`. This fans that out: a `loopback:` thread goes to the programmatic test
 * channel, everything else to the real transport (Sendblue/iMessage). So iMessage stays fully
 * live while a test thread is driven over HTTP — the channels coexist instead of replacing each
 * other. Inbound from EITHER channel reaches the single registered handler (each sub-gateway
 * stamps its own `ChannelEvent.channel`), so the router/store stay channel-agnostic.
 *
 * Only wired when `SUNNY_TEST_CHANNEL=1`; production uses the bare `SendblueGateway` unchanged.
 */
export class MultiChannelGateway implements Gateway {
  readonly channel = 'multi';
  readonly capabilities: ChannelCapabilities;

  constructor(
    private readonly primary: Gateway,
    private readonly loopbackGw: LoopbackGateway,
  ) {
    // Capabilities are read per-gateway internally (never externally), so expose the real
    // transport's as the representative set.
    this.capabilities = primary.capabilities;
  }

  /** The loopback sub-gateway (for the `/test/*` routes to inject/read). */
  loopback(): LoopbackGateway {
    return this.loopbackGw;
  }

  private route(threadId: string): Gateway {
    return threadId.startsWith('loopback:') ? this.loopbackGw : this.primary;
  }

  onInbound(handler: InboundHandler): void {
    this.primary.onInbound(handler);
    this.loopbackGw.onInbound(handler);
  }

  send(
    threadId: string,
    message: OutboundMessage,
    opts?: { persist?: boolean },
  ): Promise<SendResult> {
    return this.route(threadId).send(threadId, message, opts);
  }

  startTyping(threadId: string): Promise<void> {
    return this.route(threadId).startTyping(threadId);
  }

  stopTyping(threadId: string): Promise<void> {
    return this.route(threadId).stopTyping?.(threadId) ?? Promise.resolve();
  }

  lastSentAt(threadId: string): number | undefined {
    return this.route(threadId).lastSentAt?.(threadId);
  }

  async start(): Promise<void> {
    await this.primary.start();
    await this.loopbackGw.start();
  }

  /** The webhook is the real transport's (Sendblue); the loopback channel uses `/test/inbound`. */
  handleWebhook(request: Request): Promise<Response> {
    return this.primary.handleWebhook(request);
  }
}
