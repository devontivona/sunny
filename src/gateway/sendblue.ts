import { randomUUID } from 'node:crypto';
import { Chat, ConsoleLogger, type Adapter, type Message, type Thread } from 'chat';
import { createSendblueAdapter } from 'chat-adapter-sendblue';
import { createMemoryState } from '@chat-adapter/state-memory';
import type { SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { Authorizer } from './auth.js';
import type { ConversationStore } from './store.js';
import type {
  ChannelCapabilities,
  ChannelEvent,
  Gateway,
  InboundHandler,
  OutboundMessage,
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
  /** Live thread handles by threadId, refreshed on every inbound message. */
  private readonly activeThreads = new Map<string, Thread>();
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
    };

    const adapter = createSendblueAdapter({
      apiKey,
      apiSecret,
      defaultFromNumber: fromNumber,
      webhookSecret,
      logger: new ConsoleLogger('info', 'sendblue'),
    });

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

  async send(threadId: string, message: OutboundMessage): Promise<void> {
    const thread = this.activeThreads.get(threadId);
    if (!thread) {
      // Proactive sends to a thread not seen this session use adapter.postMessage
      // (Sendblue REST send by id); wired into the gateway in Phase 3.
      log.warn('no live thread handle for send; dropping', { threadId });
      return;
    }
    const sent = await thread.post(message.text);
    const sentId = sent?.id ?? randomUUID();
    await this.store.appendOutbound(threadId, sentId, message.text);
    log.info('sent message', { threadId, messageId: sentId });
    if (logContent()) log.info('outbound content', { threadId, text: message.text });
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
  }

  /** Normalize → authorize → persist → hand to the agent runner. */
  private async dispatch(thread: Thread, message: Message): Promise<void> {
    if (message.author.isMe) return; // never act on our own messages

    // Derive group-ness from the threadId: Sendblue encodes groups as
    // `sendblue:<from>:g:<groupId>` and DMs as `sendblue:<from>:<contact>`. The
    // adapter doesn't implement Chat SDK's optional isDM(), so thread.isDM is
    // unreliable here.
    const isGroup = thread.id.split(':')[2] === 'g';
    const senderId = message.author.userId;
    const auth = this.authorizer.authorize(senderId, isGroup);
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
      attachments: message.attachments.map((a) => ({
        id: a.url ?? a.name ?? '',
        filename: a.name ?? '',
        mimeType: a.mimeType ?? 'application/octet-stream',
        size: a.size ?? 0,
      })),
      timestamp: message.metadata?.dateSent ?? new Date(),
      isGroup,
      isOwner: auth.isOwner,
    };

    await this.store.appendInbound(event);
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
}
