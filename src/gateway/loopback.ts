import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { Authorizer } from './auth.js';
import type { ConversationStore } from './store.js';
import { runSerial } from './serial.js';
import { isGroupThreadId } from './threadId.js';
import type {
  ChannelCapabilities,
  ChannelEvent,
  Gateway,
  InboundHandler,
  OutboundMessage,
  SendResult,
} from './types.js';

const log = logger('gateway:loopback');

/** One captured outbound delivery, for programmatic read-back. */
export interface CapturedSend {
  /** Monotonic per-process sequence — use as a cursor when polling for new replies. */
  seq: number;
  threadId: string;
  text: string;
  /** epoch-ms */
  at: number;
}

/** Default test thread — a DM (no `:g:` segment ⇒ `ownerDm`), so a turn runs with owner tools. */
export const LOOPBACK_DEFAULT_THREAD = 'loopback:test:devon';

/**
 * Whether a `/test/*` request is authorized: `SUNNY_TEST_SECRET` must be set AND the provided
 * value (the `x-test-secret` header) must match it (constant-time). With no secret configured,
 * always denies — so the programmatic message-injection surface is never open even when the
 * channel is enabled.
 */
export function testChannelAuthorized(provided: string | null | undefined): boolean {
  const secret = process.env.SUNNY_TEST_SECRET;
  if (!secret) return false;
  const a = Buffer.from(provided ?? '');
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface LoopbackGatewayDeps {
  config: SunnyConfig;
  store: ConversationStore;
}

/**
 * Programmatic in-process channel (durable-main-loop test infrastructure). Implements the same
 * `Gateway` seam as `SendblueGateway`, so the agent core, router, and durable turn-runs drive a
 * FULL turn through it — but inbound is injected via a method (no webhook) and outbound is
 * CAPTURED into a queryable buffer instead of hitting iMessage. Lets scripts/tests exercise the
 * end-to-end pipeline (inbound → router → turn → delivery) and read Sunny's replies, without
 * Sendblue. Selected as the runtime's gateway by `SUNNY_TEST_CHANNEL=1` (a SEPARATE mode that
 * replaces Sendblue — there is one runtime gateway, so steps' `getRuntime().gateway.send` must
 * reach this captured buffer, not a live transport). Default OFF; production is unchanged.
 */
export class LoopbackGateway implements Gateway {
  readonly channel = 'loopback';
  readonly capabilities: ChannelCapabilities = {
    reactions: false,
    readReceipts: false,
    typing: true,
    groups: true,
    proactiveGroup: true,
    media: false,
  };

  private readonly store: ConversationStore;
  private readonly authorizer: Authorizer;
  private inboundHandler: InboundHandler | null = null;
  private readonly outbox: CapturedSend[] = [];
  private readonly sentAt = new Map<string, number>();
  private readonly sendChain = new Map<string, Promise<unknown>>();
  private readonly typingFires = new Map<string, number>();
  private readonly typingStops = new Map<string, number>();
  private seq = 0;

  constructor(deps: LoopbackGatewayDeps) {
    this.store = deps.store;
    this.authorizer = new Authorizer(deps.config);
  }

  onInbound(handler: InboundHandler): void {
    this.inboundHandler = handler;
  }

  async start(): Promise<void> {
    log.info('loopback test channel initialized (SUNNY_TEST_CHANNEL=1)');
  }

  async handleWebhook(): Promise<Response> {
    return new Response('loopback channel has no webhook; use POST /test/inbound', { status: 404 });
  }

  /** Deliver a message, SERIALIZED per thread (matches Sendblue ordering semantics). */
  async send(
    threadId: string,
    message: OutboundMessage,
    opts?: { persist?: boolean },
  ): Promise<SendResult> {
    return runSerial(this.sendChain, threadId, () => this.doSend(threadId, message, opts));
  }

  private async doSend(
    threadId: string,
    message: OutboundMessage,
    opts?: { persist?: boolean },
  ): Promise<SendResult> {
    // Loopback has no media transport: a REQUIRED attachment aborts (nothing sent),
    // matching the Sendblue invariant so send_image tests see the honest failure.
    if (message.attachment?.required) {
      return { mediaError: 'the loopback test channel cannot deliver images' };
    }
    const seq = ++this.seq;
    this.outbox.push({ seq, threadId, text: message.text, at: Date.now() });
    this.sentAt.set(threadId, Date.now());
    // The conversational turn persists its own per-turn record (D-MG9) with persist:false;
    // proactive/Tier-2 sends persist a standalone outbound row, same as the real gateway.
    if (opts?.persist ?? true) {
      await this.store.appendOutbound(threadId, randomUUID(), message.text, this.channel);
    }
    log.info('loopback send', { threadId, seq, len: message.text.length });
    return { messageId: String(seq) };
  }

  async startTyping(threadId: string): Promise<void> {
    this.typingFires.set(threadId, (this.typingFires.get(threadId) ?? 0) + 1);
  }

  async stopTyping(threadId: string): Promise<void> {
    this.typingStops.set(threadId, (this.typingStops.get(threadId) ?? 0) + 1);
  }

  lastSentAt(threadId: string): number | undefined {
    return this.sentAt.get(threadId);
  }

  // --- test-only programmatic API -----------------------------------------

  /**
   * Inject an inbound message through the SAME path the webhook uses: persist-on-arrival
   * (dedup) → the registered inbound handler (router/dispatcher). Ack-fast: the turn runs
   * async, exactly like production, so this returns immediately with a cursor the caller polls
   * {@link readOutbound} against. A DM thread is treated as the owner (the channel is itself
   * gated by a secret at the HTTP boundary).
   */
  async injectInbound(input: {
    threadId?: string;
    senderId?: string;
    senderName?: string;
    text: string;
    /** Group roster for the all-trusted membership check (multiplayer-family D5). Only used when
     *  the thread is a group AND `senderId` is provided (the tiered-auth path). */
    participants?: string[];
  }): Promise<{ messageId: string; threadId: string; cursor: number; accepted: boolean }> {
    const threadId = input.threadId ?? LOOPBACK_DEFAULT_THREAD;
    const isGroup = isGroupThreadId(threadId);

    // Two modes: (1) legacy default — no `senderId` ⇒ treat as the owner in a DM (the channel is
    // secret-gated at the HTTP layer); (2) tiered-auth — a `senderId` is run through the real
    // Authorizer so tests can exercise family/owner/outsider and group membership end to end.
    let isOwner: boolean;
    let isTrusted: boolean;
    let role: 'owner' | 'family' | null;
    let authorized: boolean;
    if (input.senderId === undefined) {
      isOwner = !isGroup;
      isTrusted = !isGroup;
      role = isGroup ? null : 'owner';
      authorized = !isGroup; // legacy: only the synthetic owner DM is auto-authorized
    } else {
      const auth = this.authorizer.authorize(input.senderId, isGroup, input.participants);
      isOwner = auth.isOwner;
      isTrusted = auth.isTrusted;
      role = auth.role;
      authorized = auth.authorized;
    }

    if (!authorized) {
      log.info('loopback inbound rejected (unauthorized sender)', {
        threadId,
        senderId: input.senderId,
        isGroup,
      });
      return { messageId: randomUUID(), threadId, cursor: this.seq, accepted: false };
    }

    const event: ChannelEvent = {
      channel: this.channel,
      threadId,
      messageId: randomUUID(),
      senderId: input.senderId ?? 'loopback-owner',
      senderName: input.senderName ?? 'Devon',
      text: input.text,
      attachments: [],
      timestamp: new Date(),
      isGroup,
      isOwner,
      isTrusted,
      senderRole: role,
    };
    const inserted = await this.store.appendInbound(event);
    const cursor = this.seq;
    if (inserted && this.inboundHandler) {
      // Fire-and-forget, like the webhook: the gateway acks immediately; the turn runs async.
      void this.inboundHandler(event).catch((err) =>
        log.error('loopback inbound handler failed', { threadId, err: String(err) }),
      );
    } else if (!inserted) {
      log.info('loopback duplicate inbound; skipping', { messageId: event.messageId });
    }
    return { messageId: event.messageId, threadId, cursor, accepted: inserted };
  }

  /** Captured outbound for a thread after `afterSeq` (the cursor from inject / a prior read). */
  readOutbound(threadId: string, afterSeq = 0): CapturedSend[] {
    return this.outbox.filter((m) => m.threadId === threadId && m.seq > afterSeq);
  }

  /** Current outbound cursor (max seq seen) — what a fresh poll should start after. */
  cursor(): number {
    return this.seq;
  }

  /** How many times typing was fired for a thread (for typing-behavior assertions). */
  typingCount(threadId: string): number {
    return this.typingFires.get(threadId) ?? 0;
  }

  /** How many times the typing indicator was explicitly cleared for a thread. */
  typingStopCount(threadId: string): number {
    return this.typingStops.get(threadId) ?? 0;
  }
}

/**
 * Resolve the loopback gateway from the runtime gateway — it's either the bare `LoopbackGateway`
 * or wrapped in a `MultiChannelGateway` (which exposes `loopback()`). Duck-typed so this module
 * doesn't import `MultiChannelGateway` (avoids a circular import). Undefined when the test
 * channel isn't wired.
 */
export function asLoopback(gateway: unknown): LoopbackGateway | undefined {
  if (gateway instanceof LoopbackGateway) return gateway;
  const wrapper = gateway as { loopback?: () => LoopbackGateway } | null;
  if (wrapper && typeof wrapper.loopback === 'function') return wrapper.loopback();
  return undefined;
}
