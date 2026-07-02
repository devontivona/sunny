import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Chat, ConsoleLogger, type Adapter, type Message, type Thread } from 'chat';
import { createSendblueAdapter } from 'chat-adapter-sendblue';
import { createMemoryState } from '@chat-adapter/state-memory';
import type { SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { Authorizer } from './auth.js';
import {
  contentTypeForName,
  isGenericBinaryType,
  kindForMediaType,
  outboundToken,
  persistInbound,
  persistOutbound,
  planOutbound,
  publicBaseUrl,
  publishOutbox,
  sniffMediaType,
  type AttachmentRef,
  type OutboundMediaResult,
} from './media.js';
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

const log = logger('gateway:sendblue');

/**
 * Dev-only: log message text. Off by default — message bodies are private.
 * Read lazily because `process.loadEnvFile()` runs after this module is imported.
 */
const logContent = (): boolean => process.env.SUNNY_LOG_CONTENT === '1';

export interface SendblueGatewayDeps {
  config: SunnyConfig;
  store: ConversationStore;
}

/**
 * iMessage driver over Sendblue (messaging-gateway D-MG1/D-MG5, tasks 2.2 & 2.6).
 *
 * Built on the Vercel Chat SDK + the published `chat-adapter-sendblue`. This is
 * the ONLY module that imports a transport — the agent core depends solely on
 * the `Gateway` interface, so the transport stays swappable. Inbound arrives as
 * a signed webhook (Sendblue POSTs to our public URL); outbound is a REST send
 * by thread id (so proactive sends work without a live handle).
 *
 * The channel id stays `imessage` — Sendblue is the iMessage transport.
 */
export class SendblueGateway implements Gateway {
  readonly channel = 'imessage';
  readonly capabilities: ChannelCapabilities;

  private readonly config: SunnyConfig;
  private readonly store: ConversationStore;
  private readonly authorizer: Authorizer;
  private readonly chat: Chat<{ sendblue: Adapter }>;
  private readonly adapter: Adapter;
  /** Live thread handles by threadId, refreshed on every inbound message. */
  private readonly activeThreads = new Map<string, Thread>();
  /** Epoch-ms of the last outbound delivery per thread (typing-suppression signal). */
  private readonly sentAt = new Map<string, number>();
  /** Per-thread send serialization: a turn may call send_message twice; each `execute` is a
   *  separate durable step that can run concurrently, and two near-simultaneous REST sends can
   *  arrive out of order. Chaining sends per thread guarantees in-order delivery. */
  private readonly sendChain = new Map<string, Promise<unknown>>();
  private inboundHandler: InboundHandler | null = null;
  private started = false;

  constructor(deps: SendblueGatewayDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.authorizer = new Authorizer(deps.config);

    // Sendblue credentials (secrets are env-only, D-PS5). The adapter also
    // auto-detects these env vars, but we pass them explicitly + validate.
    const apiKey = process.env.SENDBLUE_API_KEY;
    const apiSecret = process.env.SENDBLUE_API_SECRET;
    const fromNumber = process.env.SENDBLUE_FROM_NUMBER;
    const webhookSecret = process.env.SENDBLUE_WEBHOOK_SECRET;
    if (!apiKey || !apiSecret || !fromNumber) {
      throw new Error(
        'Sendblue needs SENDBLUE_API_KEY, SENDBLUE_API_SECRET, and SENDBLUE_FROM_NUMBER ' +
          'in the environment (Sendblue dashboard → API keys + your Sendblue number). ' +
          'SENDBLUE_WEBHOOK_SECRET is recommended to verify inbound deliveries. ' +
          'See README → "Live setup".',
      );
    }

    // Capability flags + graceful degradation (D-MG3). Sendblue supports
    // reactions, typing, groups, and durable group ids, so proactive group
    // messaging survives restarts (D-MG5).
    this.capabilities = {
      reactions: true,
      readReceipts: false,
      typing: true,
      groups: true,
      proactiveGroup: true,
      media: true,
    };

    const adapter = createSendblueAdapter({
      apiKey,
      apiSecret,
      defaultFromNumber: fromNumber,
      webhookSecret,
      logger: new ConsoleLogger('info', 'sendblue'),
    });

    this.adapter = adapter;
    this.chat = new Chat<{ sendblue: Adapter }>({
      userName: 'sunny',
      adapters: { sendblue: adapter },
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
    log.info('Sendblue gateway initialized');
  }

  async handleWebhook(request: Request): Promise<Response> {
    return this.chat.webhooks.sendblue(request);
  }

  /** Deliver a message, SERIALIZED per thread (in-order), so back-to-back sends in one turn
   *  can't arrive out of order. The actual delivery is {@link doSend}. */
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
    const isGroup = isGroupThreadId(threadId);
    // Decide how the optional attachment is delivered (D-MM5/6/7): native media in
    // a DM, a hosted public link in a group, a URL passed straight through, or
    // dropped (text-only) if the channel lacks media support.
    const plan = planOutbound(message.attachment, { media: this.capabilities.media, isGroup });

    let text = message.text;
    let mediaUrl: string | undefined;
    let media: OutboundMediaResult | undefined;
    try {
      if (plan.kind === 'url') {
        mediaUrl = plan.url; // existing URL — no hosting (D-MM4)
        media = {
          url: plan.url,
          mediaType: 'image/*',
          kind: 'image',
          name: plan.url.split('/').pop() || 'image',
        };
      } else if (plan.kind === 'host') {
        const hosted = this.hostLocalFile(plan.pathOrUrl, plan.mimeType);
        mediaUrl = hosted.publicUrl;
        media = hosted.media;
      } else if (plan.kind === 'link') {
        // Group: media send is DM-only, so post the public URL as text (D-MM6).
        if (/^https?:\/\//i.test(plan.pathOrUrl)) {
          text = [message.text, plan.pathOrUrl].filter(Boolean).join('\n');
          media = {
            url: plan.pathOrUrl,
            mediaType: 'image/*',
            kind: 'image',
            name: plan.pathOrUrl.split('/').pop() || 'image',
          };
        } else {
          const hosted = this.hostLocalFile(plan.pathOrUrl, plan.mimeType);
          text = [message.text, hosted.publicUrl].filter(Boolean).join('\n');
          media = hosted.media;
        }
      }
    } catch (err) {
      // A bad image path must not ghost the text — deliver the text anyway (D-MM2).
      log.warn('outbound attachment failed; sending text only', {
        threadId,
        err: String(err),
      });
      mediaUrl = undefined;
      media = undefined;
      text = message.text;
    }

    const thread = this.activeThreads.get(threadId);
    let sentId: string;
    if (mediaUrl) {
      // Native MMS: Sendblue fetches the public media_url server-side (DM-only).
      // sendMediaMessage is on the Sendblue adapter, not the base `Adapter` seam.
      await (
        this.adapter as unknown as {
          sendMediaMessage(threadId: string, mediaUrl: string, content?: string): Promise<void>;
        }
      ).sendMediaMessage(threadId, mediaUrl, text);
      sentId = randomUUID();
    } else if (thread) {
      // Reply within the current session — use the live thread handle.
      const sent = await thread.post(text);
      sentId = sent?.id ?? randomUUID();
    } else {
      // Proactive send (no live thread this session, e.g. a scheduled run or a
      // durable job completing after a restart): Sendblue REST send by thread id.
      const sent = await this.adapter.postMessage(threadId, text);
      sentId = (sent as { id?: string })?.id ?? randomUUID();
    }
    // Record the delivery time so the typing driver can suppress the indicator right
    // after a message lands (durable-main-loop typing fix).
    this.sentAt.set(threadId, Date.now());
    // The conversational loop persists its own per-turn record (D-MG9), so it
    // opts out here; proactive/Tier-2 sends persist a standalone outbound row.
    if (opts?.persist ?? true) {
      await this.store.appendOutbound(threadId, sentId, text, 'imessage', media);
    }
    log.info('sent message', {
      threadId,
      messageId: sentId,
      proactive: !thread,
      media: media ? ('path' in media ? 'hosted' : 'url') : 'none',
    });
    if (logContent()) log.info('outbound content', { threadId, text });
    return { messageId: sentId, media };
  }

  /**
   * Host a local file for outbound media (D-MM4): persist a durable copy (for
   * dashboard rendering) and a short-TTL public-outbox copy, and build the public
   * URL Sendblue fetches. Bytes never hit the log (D-MM8).
   */
  private hostLocalFile(
    path: string,
    mimeType?: string,
  ): { publicUrl: string; media: OutboundMediaResult } {
    const bytes = readFileSync(path);
    const mediaType = mimeType ?? contentTypeForName(path);
    const token = outboundToken();
    const durablePath = persistOutbound(this.config.runtimeDir, token, bytes, mediaType);
    const outboxName = publishOutbox(this.config.runtimeDir, bytes, mediaType);
    return {
      publicUrl: `${publicBaseUrl()}/media/${outboxName}`,
      media: {
        path: durablePath,
        mediaType,
        kind: kindForMediaType(mediaType),
        name: path.split('/').pop() || 'image',
      },
    };
  }

  async startTyping(threadId: string): Promise<void> {
    if (!this.capabilities.typing) return;
    const thread = this.activeThreads.get(threadId);
    if (!thread) return;
    try {
      await thread.startTyping();
    } catch (err) {
      log.debug('startTyping failed (non-fatal)', { threadId, err: String(err) });
    }
  }

  /**
   * Clear the typing indicator (Sendblue typing-v2 `state: 'stop'`). The chat-SDK `Adapter`/
   * `Thread` interface only exposes `startTyping`, so we go straight to the adapter's already-
   * configured raw Sendblue client (`sdk.typingIndicators.send`, which supports `state`) and its
   * own `decodeThreadId` to resolve the E.164 numbers — no second client, no duplicated auth.
   * Feature-detected + best-effort: if the adapter internals ever change shape, or it's a group
   * (Sendblue has no group typing), this no-ops and the indicator falls back to auto-expiry.
   */
  async stopTyping(threadId: string): Promise<void> {
    if (!this.capabilities.typing) return;
    const sb = this.adapter as unknown as {
      sdk?: { typingIndicators?: { send: (b: Record<string, unknown>) => Promise<unknown> } };
      decodeThreadId?: (id: string) => {
        fromNumber: string;
        contactNumber?: string;
        groupId?: string;
      };
    };
    const send = sb.sdk?.typingIndicators?.send;
    if (typeof send !== 'function' || typeof sb.decodeThreadId !== 'function') return;
    try {
      const decoded = sb.decodeThreadId(threadId);
      if (!decoded.contactNumber) return; // DMs only — Sendblue typing isn't supported in groups
      await send.call(sb.sdk!.typingIndicators, {
        from_number: decoded.fromNumber,
        number: decoded.contactNumber,
        state: 'stop',
      });
    } catch (err) {
      log.debug('stopTyping failed (non-fatal)', { threadId, err: String(err) });
    }
  }

  lastSentAt(threadId: string): number | undefined {
    return this.sentAt.get(threadId);
  }

  private registerHandlers(): void {
    // DMs: the primary path. Sendblue addresses by phone number, so replies and
    // proactive DMs work across restarts (D-MG5).
    this.chat.onDirectMessage(async (thread, message) => {
      await this.dispatch(thread, message);
    });

    // Groups: subscribe on first mention, then handle subsequent messages.
    this.chat.onNewMention(async (thread, message) => {
      await thread.subscribe();
      await this.dispatch(thread, message);
    });
    this.chat.onSubscribedMessage(async (thread, message) => {
      await this.dispatch(thread, message);
    });

    // Group participation WITHOUT requiring an @mention (multiplayer-family D6 / OQ1): a match-all
    // pattern fires `onNewMessage` for any message in an UNSUBSCRIBED thread, so Sunny sees a family
    // group's first message even when not mentioned. We bootstrap-subscribe and dispatch (which
    // authorizes the all-trusted roster); afterwards `onSubscribedMessage` carries every message and
    // the agent uses per-turn discretion (send_message / stay_silent). DMs are handled by
    // `onDirectMessage`, so this guards to groups only (and the store dedups any overlap anyway).
    this.chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
      if (!isGroupThreadId(thread.id)) return;
      await thread.subscribe();
      await this.dispatch(thread, message);
    });
  }

  /** Normalize → authorize → persist → hand to the agent runner. */
  private async dispatch(thread: Thread, message: Message): Promise<void> {
    if (message.author.isMe) return; // never act on our own messages

    // Derive group-ness from the threadId: Sendblue encodes groups as
    // `sendblue:<from>:g:<groupId>` and DMs as `sendblue:<from>:<contact>`. The
    // adapter doesn't implement Chat SDK's optional isDM(), so thread.isDM is
    // unreliable here.
    const isGroup = isGroupThreadId(thread.id);
    const senderId = message.author.userId;

    // For groups, authorize only when EVERY participant is trusted (multiplayer-family D5). The
    // roster is fetched live and re-checked on every message, so an outsider added mid-thread
    // silences the whole group on the next message. Sunny's own handle is excluded. If the roster
    // can't be determined, `authorize` fails CLOSED (participantIds === undefined).
    let participantIds: string[] | undefined;
    if (isGroup) {
      try {
        const participants = await thread.getParticipants();
        const ids = participants.filter((p) => !p.isMe).map((p) => p.userId);
        participantIds = ids.length > 0 ? ids : undefined;
      } catch (err) {
        log.warn('group roster unavailable; failing closed', {
          threadId: thread.id,
          err: String(err),
        });
        participantIds = undefined;
      }
    }

    const auth = this.authorizer.authorize(senderId, isGroup, participantIds);
    if (!auth.authorized) {
      log.warn('unauthorized sender; not triggering agent', { senderId, isGroup });
      return;
    }

    // Keep the live handle for outbound sends/typing during this turn.
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
          // Retrievable content (D-MM1): the adapter exposes fetchData (a plain
          // fetch of the expiring media_url) or inlined bytes for data: URIs.
          fetchData: a.fetchData,
          data: a.data instanceof Buffer ? a.data : undefined,
          url: a.url,
        };
      }),
      timestamp: message.metadata?.dateSent ?? new Date(),
      isGroup,
      isOwner: auth.isOwner,
      isTrusted: auth.isTrusted,
      senderRole: auth.role,
    };

    // Fetch + persist attachment bytes PROMPTLY (Sendblue URLs expire, D-MM2). A
    // per-attachment failure is non-fatal: the message + other attachments still
    // go through, with the failure recorded as a note.
    const refs = event.attachments.length > 0 ? await this.persistAttachments(event) : [];

    // Persist on arrival with dedup (D-DE1): a webhook retry of the same message
    // is a no-op and is not re-processed.
    const inserted = await this.store.appendInbound(event, refs);
    if (!inserted) {
      log.info('duplicate inbound; skipping', { messageId: event.messageId });
      return;
    }
    if (event.attachments.length > 0) {
      // Metadata only — attachment bytes never hit the log (D-MM8).
      log.info('inbound attachments', {
        messageId: event.messageId,
        count: event.attachments.length,
        types: event.attachments.map((a) => a.mimeType),
        saved: refs.filter((r) => r.path).length,
      });
    }
    if (logContent()) {
      log.info('inbound content', {
        from: senderId,
        isOwner: auth.isOwner,
        isGroup,
        text: event.text,
      });
    }

    if (!this.inboundHandler) {
      log.error('no inbound handler registered; dropping message', { threadId: thread.id });
      return;
    }
    await this.inboundHandler(event);
  }

  /**
   * Fetch + persist each attachment's bytes to disk (D-MM2). Returns a ref per
   * attachment (saved path, or `error` if the fetch failed — never throws, so one
   * bad attachment can't drop the message). Bytes stay out of the log (D-MM8).
   */
  private async persistAttachments(event: ChannelEvent): Promise<AttachmentRef[]> {
    const refs: AttachmentRef[] = [];
    for (let i = 0; i < event.attachments.length; i++) {
      const a = event.attachments[i]!;
      const name = a.filename || `attachment-${i}`;
      try {
        const bytes = a.data ?? (a.fetchData ? await a.fetchData() : null);
        if (!bytes || bytes.length === 0) throw new Error('no attachment content');
        // Recover the real type when the transport left it unlabeled/generic (Sendblue
        // often delivers a PDF as application/octet-stream): sniff the magic bytes so a
        // PDF/image routes to NATIVE model ingestion instead of being read as raw text
        // (which poisoned the durable turn). Keeps the declared type when it's specific.
        const mediaType = isGenericBinaryType(a.mimeType)
          ? sniffMediaType(bytes, a.mimeType || 'application/octet-stream')
          : a.mimeType;
        const path = persistInbound(this.config.runtimeDir, event.messageId, i, bytes, mediaType);
        refs.push({
          path,
          mediaType,
          kind: kindForMediaType(mediaType),
          name,
          size: bytes.length,
          direction: 'inbound',
        });
      } catch (err) {
        log.warn('inbound attachment fetch failed (non-fatal)', {
          messageId: event.messageId,
          index: i,
          err: String(err),
        });
        refs.push({
          path: null,
          mediaType: a.mimeType,
          kind: a.kind,
          name,
          size: a.size,
          direction: 'inbound',
          error: String(err),
        });
      }
    }
    return refs;
  }
}
