import { randomUUID } from 'node:crypto';
import { Chat, ConsoleLogger, type Adapter, type Message, type Thread } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import type { SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { Authorizer } from './auth.js';
import {
  contentTypeForName,
  kindForMediaType,
  outboundToken,
  persistInboundAttachments,
  persistOutbound,
  waitForStableFile,
  type OutboundMediaResult,
} from './media.js';
import type { ConversationStore } from './store.js';
import type { ShortLinker } from './shortlinks.js';
import { runSerial } from './serial.js';
import { normalizeDateSent } from './sendblue.js';
import type {
  ChannelCapabilities,
  ChannelEvent,
  Gateway,
  InboundHandler,
  OutboundMessage,
  SendResult,
} from './types.js';

const log = logger('gateway:slack');

/** Dev-only content logging, same switch as the Sendblue driver. */
const logContent = (): boolean => process.env.SUNNY_LOG_CONTENT === '1';

/**
 * Whether a Chat SDK Slack thread id addresses a DM. Ids are
 * `slack:<channelId>:<thread_ts>`; Slack channel ids are typed by prefix
 * (`D…` = DM/IM, `C…` = public/private channel, `G…` = legacy group). Note the
 * second segment is a channel id, never `'g'`, so `isGroupThreadId` correctly
 * reads every Slack thread as non-group under the v1 DM-only scope.
 */
export function isSlackDmThreadId(threadId: string): boolean {
  return (threadId.split(':')[1] ?? '').startsWith('D');
}

export interface SlackGatewayDeps {
  config: SunnyConfig;
  store: ConversationStore;
  /** Outbound URL shortening (short-links spec) — same chokepoint as every transport. */
  shortener?: ShortLinker;
}

/**
 * Slack channel driver (add-slack-channel): a DM-only reply lane in Devon's work
 * workspace, behind the same `Gateway` seam as Sendblue/loopback. Built on the
 * official Chat SDK Slack adapter (signature verification, `url_verification`
 * challenge, event normalization, authenticated file transfer all come from it).
 *
 * v1 scope (slack-channel spec): only rostered DMs dispatch turns. Mention and
 * channel traffic is ACCEPTED at the webhook (Slack needs its 200) but never
 * reaches the agent — the handlers are registered so future group support is a
 * roster/policy change, not a rewire. Proactive speech stays on iMessage
 * (messaging-gateway "home channel" requirement): this driver only ever speaks
 * into threads its own inbound created.
 */
export class SlackGateway implements Gateway {
  readonly channel = 'slack';
  readonly capabilities: ChannelCapabilities = {
    reactions: false,
    readReceipts: false,
    typing: true,
    // Deliberately false in v1: the group-participation model (and its trust
    // policy for a workspace with unrostered members) is deferred.
    groups: false,
    proactiveGroup: false,
    media: true,
  };

  private readonly config: SunnyConfig;
  private readonly store: ConversationStore;
  private readonly authorizer: Authorizer;
  private readonly shortener: ShortLinker | undefined;
  private readonly chat: Chat<{ slack: Adapter }>;
  private readonly adapter: Adapter;
  /** Live thread handles by threadId, refreshed on every inbound (send/typing reuse). */
  private readonly activeThreads = new Map<string, Thread>();
  private readonly sentAt = new Map<string, number>();
  /** Per-thread send serialization — same in-order guarantee as the Sendblue driver. */
  private readonly sendChain = new Map<string, Promise<unknown>>();
  private inboundHandler: InboundHandler | null = null;
  private started = false;

  constructor(deps: SlackGatewayDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.shortener = deps.shortener;
    this.authorizer = new Authorizer(deps.config);

    const botToken = process.env.SLACK_BOT_TOKEN;
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!botToken || !signingSecret) {
      throw new Error(
        'Slack needs SLACK_BOT_TOKEN (xoxb-…) and SLACK_SIGNING_SECRET in the environment ' +
          '(Slack app → OAuth & Permissions / Basic Information). SLACK_SIGNING_SECRET is ' +
          'REQUIRED so inbound webhooks are always signature-verified. See .env.example.',
      );
    }

    const adapter = createSlackAdapter({
      botToken,
      signingSecret,
      mode: 'webhook',
      logger: new ConsoleLogger('info', 'slack'),
    });
    this.adapter = adapter as unknown as Adapter;
    this.chat = new Chat<{ slack: Adapter }>({
      userName: 'sunny',
      adapters: { slack: this.adapter },
      state: createMemoryState(),
    });

    this.registerHandlers();
  }

  onInbound(handler: InboundHandler): void {
    this.inboundHandler = handler;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.chat.initialize();
    this.started = true;
    log.info('Slack gateway initialized (DM-only v1)');
  }

  /**
   * Inbound Slack Events API webhook. The adapter verifies the request signature
   * (+ timestamp freshness) and answers the `url_verification` challenge itself;
   * events are acked fast and processed async — a slow ack would trigger Slack's
   * ~3s retry, which the store-level `(channel, messageId)` dedupe absorbs anyway.
   */
  async handleWebhook(request: Request): Promise<Response> {
    return this.chat.webhooks.slack(request);
  }

  /** Deliver a message, SERIALIZED per thread (in-order), same as every driver. */
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
    // Outbound media goes through Slack's AUTHENTICATED file upload — never the
    // public /media/[token] outbox (that route exists only because Sendblue must
    // fetch media_url server-side; slack-channel spec forbids it here).
    let text = message.text;
    let files: Array<{ data: Buffer; filename: string; mimeType: string }> | undefined;
    let media: OutboundMediaResult | undefined;
    let mediaError: string | undefined;
    const attachment = message.attachment;
    if (attachment) {
      try {
        if (/^https?:\/\//i.test(attachment.pathOrUrl)) {
          // Existing URL: post it as text — Slack unfurls a preview natively.
          text = [message.text, attachment.pathOrUrl].filter(Boolean).join('\n');
          media = {
            url: attachment.pathOrUrl,
            mediaType: attachment.mimeType ?? 'image/*',
            kind: 'image',
            name: attachment.pathOrUrl.split('/').pop() || 'image',
          };
        } else {
          // Local file Sunny produced: wait for the write to settle (the model's
          // file_write and send race as concurrent tool calls — image-send-integrity),
          // then upload the bytes natively and keep a durable copy for the dashboard.
          const bytes = await waitForStableFile(attachment.pathOrUrl);
          const mediaType = attachment.mimeType ?? contentTypeForName(attachment.pathOrUrl);
          const filename = attachment.pathOrUrl.split('/').pop() || 'image';
          files = [{ data: bytes, filename, mimeType: mediaType }];
          const durablePath = persistOutbound(
            this.config.runtimeDir,
            outboundToken(),
            bytes,
            mediaType,
          );
          media = {
            path: durablePath,
            mediaType,
            kind: kindForMediaType(mediaType),
            name: filename,
          };
        }
      } catch (err) {
        mediaError = err instanceof Error ? err.message : String(err);
        // Required attachment IS the message: abort — never send a caption-only
        // text pretending to carry an image (image-send-integrity).
        if (attachment.required) {
          log.warn('required outbound attachment failed; send aborted', {
            threadId,
            err: String(err),
          });
          return { mediaError };
        }
        log.warn('outbound attachment failed; sending text only', { threadId, err: String(err) });
        files = undefined;
        media = undefined;
        text = message.text;
      }
    }

    // Short-link rewrite (short-links spec): last transformation before the wire.
    // Persistence keeps the original text so model-facing history never sees them.
    const wireText = this.shortener ? await this.shortener.rewrite(text) : text;

    // Live handle when this thread saw inbound this session; otherwise a handle
    // minted from the id (thread replies after a restart land correctly).
    const thread = this.activeThreads.get(threadId) ?? this.chat.thread(threadId);
    const sent = files
      ? await thread.post({ markdown: wireText, files })
      : await thread.post(wireText);
    // Slack's post is synchronous-success: the API result is TERMINAL. No
    // DeliveryTracker here — there are no async delivery-status callbacks to
    // correlate (slack-channel spec "send failure surfaces immediately").
    const sentId = sent?.id || randomUUID();
    this.sentAt.set(threadId, Date.now());
    if (opts?.persist ?? true) {
      // Same swallow rationale as Sendblue (R10-send): the transport send already
      // happened; a thrown persist error inside a retried step would double-send.
      try {
        await this.store.appendOutbound(threadId, sentId, text, this.channel, media);
      } catch (err) {
        log.error('appendOutbound failed after a successful send; outbound history row lost', {
          threadId,
          messageId: sentId,
          err: String(err),
        });
      }
    }
    log.info('sent message', {
      threadId,
      messageId: sentId,
      media: media ? ('path' in media ? 'uploaded' : 'url') : 'none',
    });
    if (logContent()) log.info('outbound content', { threadId, text });
    return { messageId: sentId, media, ...(mediaError ? { mediaError } : {}) };
  }

  /**
   * Typing → Slack's assistant status/typing surface, via the adapter's own
   * `startTyping` (feature-detected; the classic-DM surface may not support it).
   * Best-effort by contract: failures are swallowed and logged at debug.
   */
  async startTyping(threadId: string): Promise<void> {
    try {
      const adapter = this.adapter as unknown as {
        startTyping?: (threadId: string) => Promise<void>;
      };
      if (typeof adapter.startTyping === 'function') await adapter.startTyping(threadId);
      log.debug('typing indicator sent', { threadId });
    } catch (err) {
      log.debug('startTyping failed (non-fatal)', { threadId, err: String(err) });
    }
  }

  // No stopTyping: Slack's assistant status clears itself when the reply posts,
  // so the Gateway's optional member is omitted (auto-expiring indicator).

  lastSentAt(threadId: string): number | undefined {
    return this.sentAt.get(threadId);
  }

  private registerHandlers(): void {
    // DMs: the only dispatching path in v1.
    this.chat.onDirectMessage(async (thread, message) => {
      await this.dispatch(thread, message);
    });
    // Mentions + subscribed threads: registered NOW so group support later is a
    // policy change, but dispatch() drops every non-DM in v1 (fail-closed). The
    // mention handler deliberately does NOT subscribe — subscribing would opt
    // Sunny into a channel thread's full message stream before any trust model
    // for workspace channels exists.
    this.chat.onNewMention(async (thread, message) => {
      await this.dispatch(thread, message);
    });
    this.chat.onSubscribedMessage(async (thread, message) => {
      await this.dispatch(thread, message);
    });
  }

  /** Normalize → authorize → persist → hand to the agent runner (mirrors Sendblue). */
  private async dispatch(thread: Thread, message: Message): Promise<void> {
    if (message.author.isMe) return; // never act on our own messages

    // v1 DM-only scope (slack-channel spec): anything not a DM is received —
    // Slack got its 200 — but never dispatched.
    if (!isSlackDmThreadId(thread.id)) {
      log.info('non-DM Slack event ignored (v1 DM-only scope)', { threadId: thread.id });
      return;
    }

    const senderId = message.author.userId;
    const auth = this.authorizer.authorize(senderId, false);
    if (!auth.authorized) {
      // Fail closed, no reply: a workspace member who isn't rostered gets
      // silence, not an information leak (slack-channel spec).
      log.warn('unauthorized sender; not triggering agent', { senderId, threadId: thread.id });
      return;
    }

    this.activeThreads.set(thread.id, thread);

    const event: ChannelEvent = {
      channel: this.channel,
      threadId: thread.id,
      messageId: message.id,
      senderId,
      senderName: message.author.fullName,
      text: message.text,
      attachments: message.attachments.map((a) => {
        const mimeType = a.mimeType ?? 'application/octet-stream';
        return {
          id: a.url ?? a.name ?? '',
          filename: a.name ?? '',
          mimeType,
          size: a.size ?? 0,
          kind: a.type ?? kindForMediaType(mimeType),
          // The adapter's fetchData carries the bot-token auth Slack file
          // downloads require (slack-channel spec: authenticated media in).
          fetchData: a.fetchData,
          data: a.data instanceof Buffer ? a.data : undefined,
          url: a.url,
        };
      }),
      timestamp: normalizeDateSent(message.metadata?.dateSent),
      isGroup: false,
      isOwner: auth.isOwner,
      isTrusted: auth.isTrusted,
      senderRole: auth.role,
    };

    const refs =
      event.attachments.length > 0
        ? await persistInboundAttachments(this.config.runtimeDir, event)
        : [];

    // Persist on arrival with dedupe (D-DE1): Slack retries undelivered events
    // ~3×; a redelivery of the same message id is a no-op here.
    const inserted = await this.store.appendInbound(event, refs);
    if (!inserted) {
      log.info('duplicate inbound; skipping', { messageId: event.messageId });
      return;
    }
    if (event.attachments.length > 0) {
      log.info('inbound attachments', {
        messageId: event.messageId,
        count: event.attachments.length,
        types: event.attachments.map((a) => a.mimeType),
        saved: refs.filter((r) => r.path).length,
      });
    }
    if (logContent()) {
      log.info('inbound content', { from: senderId, isOwner: auth.isOwner, text: event.text });
    }

    if (!this.inboundHandler) {
      log.error('no inbound handler registered; dropping message', { threadId: thread.id });
      return;
    }
    await this.inboundHandler(event);
  }
}

/**
 * Resolve the Slack driver from the runtime gateway — the bare `SlackGateway` or a
 * multi-channel wrapper exposing `driverFor('slack')`. Duck-typed so route modules
 * don't need the wrapper type. Undefined when Slack isn't configured.
 */
export function asSlackGateway(gateway: unknown): SlackGateway | undefined {
  if (gateway instanceof SlackGateway) return gateway;
  const wrapper = gateway as { driverFor?: (channel: string) => unknown } | null;
  if (wrapper && typeof wrapper.driverFor === 'function') {
    const driver = wrapper.driverFor('slack');
    if (driver instanceof SlackGateway) return driver;
  }
  return undefined;
}
