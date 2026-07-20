import type {
  ChannelCapabilities,
  ChannelId,
  Gateway,
  InboundHandler,
  OutboundMessage,
  SendResult,
} from './types.js';
import type { LoopbackGateway } from './loopback.js';

/** Optional secondary drivers running alongside the primary transport. */
export interface MultiChannelExtras {
  /** Programmatic test channel (SUNNY_TEST_CHANNEL=1). */
  loopback?: LoopbackGateway;
  /** Slack DM channel (add-slack-channel). */
  slack?: Gateway;
}

/**
 * Runs multiple channel drivers at once and routes by thread-id prefix.
 *
 * The agent core, router, and durable turn-runs all deliver through one
 * `getRuntime().gateway`, keyed by `threadId`. This fans that out: `loopback:`
 * threads go to the programmatic test channel, `slack:` threads to the Slack
 * driver, everything else to the primary transport (Sendblue/iMessage). Inbound
 * from EVERY channel reaches the single registered handler (each sub-gateway
 * stamps its own `ChannelEvent.channel`), so the router/store stay
 * channel-agnostic.
 *
 * Webhooks dispatch PER CHANNEL (messaging-gateway "Per-channel webhook
 * dispatch"): each webhook route resolves its own driver via {@link driverFor}
 * instead of funneling through one handler — `/webhooks/sendblue` reaches the
 * primary, `/webhooks/slack` reaches the Slack driver.
 */
export class MultiChannelGateway implements Gateway {
  readonly channel = 'multi';
  readonly capabilities: ChannelCapabilities;

  constructor(
    private readonly primary: Gateway,
    private readonly extras: MultiChannelExtras,
  ) {
    // Capabilities are read per-gateway internally (never externally), so expose the real
    // transport's as the representative set.
    this.capabilities = primary.capabilities;
  }

  /** The loopback sub-gateway (for the `/test/*` routes to inject/read). */
  loopback(): LoopbackGateway | undefined {
    return this.extras.loopback;
  }

  /**
   * Resolve a driver by its channel id (`imessage`, `slack`, `loopback`) — the
   * per-channel webhook dispatch seam. Undefined when that channel isn't wired.
   */
  driverFor(channel: ChannelId): Gateway | undefined {
    if (channel === 'slack') return this.extras.slack;
    if (channel === 'loopback') return this.extras.loopback;
    if (channel === this.primary.channel) return this.primary;
    return undefined;
  }

  private route(threadId: string): Gateway {
    if (threadId.startsWith('loopback:') && this.extras.loopback) return this.extras.loopback;
    if (threadId.startsWith('slack:') && this.extras.slack) return this.extras.slack;
    return this.primary;
  }

  onInbound(handler: InboundHandler): void {
    this.primary.onInbound(handler);
    this.extras.loopback?.onInbound(handler);
    this.extras.slack?.onInbound(handler);
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
    await this.extras.loopback?.start();
    await this.extras.slack?.start();
  }

  /**
   * Back-compat: the bare `gateway.handleWebhook` remains the PRIMARY transport's
   * (Sendblue). Channel routes should prefer {@link driverFor} — the Slack route
   * resolves its own driver and never lands here.
   */
  handleWebhook(request: Request): Promise<Response> {
    return this.primary.handleWebhook(request);
  }
}
