import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackGateway, isSlackDmThreadId } from './slack.js';
import { MEDIA } from './media.js';
import type { ConversationStore } from './store.js';
import type { ChannelEvent } from './types.js';
import { makeConfig } from '../../tests/factories.js';

/**
 * Slack driver guards (add-slack-channel, tasks 4.1):
 *  - Constructor hard-requires both Slack secrets (signature verification always on).
 *  - v1 DM-only scope: only rostered DM senders dispatch; non-roster DMs and any
 *    channel/mention traffic are dropped with no reply (fail-closed).
 *  - Retry dedupe: a redelivered event (same message id) never drives a second turn.
 *  - Send: discrete posts, per-thread in-order serialization, required-attachment
 *    abort, and the R10-send persist-failure swallow — same invariants as Sendblue.
 */

const OWNER_SLACK_ID = 'U0AAAAAAA';
const DM_THREAD = 'slack:D0DEVON:1721000000.000100';
const CHANNEL_THREAD = 'slack:C0GENERAL:1721000000.000200';

const REQUIRED_ENV = {
  SLACK_BOT_TOKEN: 'xoxb-test-token',
  SLACK_SIGNING_SECRET: 'slack-signing-secret',
} as const;

const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  for (const k of Object.keys(REQUIRED_ENV)) savedEnv[k] = process.env[k];
  setEnv(REQUIRED_ENV);
});

afterEach(() => {
  setEnv(savedEnv);
  vi.restoreAllMocks();
});

const slackConfig = () => makeConfig({ owner: { name: 'Devon', identities: [OWNER_SLACK_ID] } });

type Dispatchable = { dispatch(t: unknown, m: unknown): Promise<void> };

function makeMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `slack-msg-${Math.random().toString(36).slice(2)}`,
    text: 'hey sunny',
    author: { isMe: false, userId: OWNER_SLACK_ID, fullName: 'Devon' },
    attachments: [],
    metadata: { dateSent: new Date('2026-07-20T12:00:00.000Z') },
    ...overrides,
  };
}

describe('isSlackDmThreadId', () => {
  it('is true for DM channel ids (D…) and false for channels (C…) / groups (G…)', () => {
    expect(isSlackDmThreadId(DM_THREAD)).toBe(true);
    expect(isSlackDmThreadId(CHANNEL_THREAD)).toBe(false);
    expect(isSlackDmThreadId('slack:G0LEGACY:1.2')).toBe(false);
    expect(isSlackDmThreadId('not-a-slack-id')).toBe(false);
  });
});

describe('SlackGateway constructor — required secrets', () => {
  const store = {} as ConversationStore;

  it('throws when SLACK_SIGNING_SECRET is missing (verification must always be on)', () => {
    delete process.env.SLACK_SIGNING_SECRET;
    expect(() => new SlackGateway({ config: slackConfig(), store })).toThrow(
      /SLACK_SIGNING_SECRET/,
    );
  });

  it('throws when SLACK_BOT_TOKEN is missing', () => {
    delete process.env.SLACK_BOT_TOKEN;
    expect(() => new SlackGateway({ config: slackConfig(), store })).toThrow(/SLACK_BOT_TOKEN/);
  });

  it('constructs when both secrets are present', () => {
    expect(() => new SlackGateway({ config: slackConfig(), store })).not.toThrow();
  });
});

describe('dispatch — v1 DM-only authorization (fail-closed)', () => {
  it('dispatches a rostered owner DM: normalized event persisted + handed to the handler', async () => {
    const appendInbound = vi.fn(async () => true);
    const store = { appendInbound } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });

    let captured: ChannelEvent | undefined;
    gw.onInbound(async (event) => {
      captured = event;
    });

    const message = makeMessage({ id: 'in-dm-1' });
    await (gw as unknown as Dispatchable).dispatch({ id: DM_THREAD }, message);

    expect(appendInbound).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(captured!.channel).toBe('slack');
    expect(captured!.threadId).toBe(DM_THREAD);
    expect(captured!.senderId).toBe(OWNER_SLACK_ID);
    expect(captured!.isGroup).toBe(false);
    expect(captured!.isOwner).toBe(true);
    expect(captured!.senderRole).toBe('owner');
  });

  it('drops a non-roster DM: nothing persisted, no handler, no reply', async () => {
    const appendInbound = vi.fn(async () => true);
    const store = { appendInbound } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const handler = vi.fn();
    gw.onInbound(handler);

    const message = makeMessage({
      author: { isMe: false, userId: 'U9OUTSIDER', fullName: 'Coworker' },
    });
    await (gw as unknown as Dispatchable).dispatch({ id: DM_THREAD }, message);

    expect(appendInbound).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops channel traffic even from the rostered owner (v1 DM-only scope)', async () => {
    const appendInbound = vi.fn(async () => true);
    const store = { appendInbound } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const handler = vi.fn();
    gw.onInbound(handler);

    await (gw as unknown as Dispatchable).dispatch({ id: CHANNEL_THREAD }, makeMessage());

    expect(appendInbound).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('never acts on its own messages', async () => {
    const appendInbound = vi.fn(async () => true);
    const store = { appendInbound } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const handler = vi.fn();
    gw.onInbound(handler);

    const message = makeMessage({ author: { isMe: true, userId: 'UBOT', fullName: 'sunny' } });
    await (gw as unknown as Dispatchable).dispatch({ id: DM_THREAD }, message);

    expect(appendInbound).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('dispatch — Slack retry dedupe (slack-channel spec)', () => {
  it('a redelivered event (store dedupe returns false) never drives a second turn', async () => {
    // First insert wins; the redelivery is a conflict no-op.
    const appendInbound = vi.fn(async () => false);
    const store = { appendInbound } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const handler = vi.fn();
    gw.onInbound(handler);

    const message = makeMessage({ id: 'retried-once' });
    await (gw as unknown as Dispatchable).dispatch({ id: DM_THREAD }, message);

    expect(appendInbound).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled(); // duplicate → no turn
  });
});

describe('send — discrete posts, in order, terminal results', () => {
  it('posts text via the live thread handle and persists with the slack channel id', async () => {
    const appendOutbound = vi.fn(async () => undefined);
    const store = { appendOutbound } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const post = vi.fn(async () => ({ id: 'slack-ts-1' }));
    (gw as unknown as { activeThreads: Map<string, unknown> }).activeThreads.set(DM_THREAD, {
      post,
    });

    const result = await gw.send(DM_THREAD, { text: 'hello from sunny' }, { persist: true });

    expect(result.messageId).toBe('slack-ts-1');
    expect(post).toHaveBeenCalledWith('hello from sunny');
    expect(appendOutbound).toHaveBeenCalledTimes(1);
    const persistArgs = appendOutbound.mock.calls[0] as unknown[];
    expect(persistArgs[1]).toBe('slack-ts-1');
    expect(persistArgs[3]).toBe('slack');
  });

  it('serializes per-thread sends in order (interim update then final reply)', async () => {
    const store = { appendOutbound: vi.fn(async () => undefined) } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const order: string[] = [];
    // First post resolves SLOWLY; without serialization the second would land first.
    const post = vi
      .fn()
      .mockImplementationOnce(async (text: string) => {
        await new Promise((r) => setTimeout(r, 40));
        order.push(text);
        return { id: 't1' };
      })
      .mockImplementationOnce(async (text: string) => {
        order.push(text);
        return { id: 't2' };
      });
    (gw as unknown as { activeThreads: Map<string, unknown> }).activeThreads.set(DM_THREAD, {
      post,
    });

    await Promise.all([
      gw.send(DM_THREAD, { text: 'still working on it…' }, { persist: false }),
      gw.send(DM_THREAD, { text: 'done — here is the answer' }, { persist: false }),
    ]);

    expect(order).toEqual(['still working on it…', 'done — here is the answer']);
  });

  it('does not re-throw when appendOutbound rejects after delivery (R10-send)', async () => {
    const appendOutbound = vi.fn().mockRejectedValue(new Error('db down after send'));
    const store = { appendOutbound } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const post = vi.fn(async () => ({ id: 'slack-ts-2' }));
    (gw as unknown as { activeThreads: Map<string, unknown> }).activeThreads.set(DM_THREAD, {
      post,
    });

    await expect(gw.send(DM_THREAD, { text: 'hello' }, { persist: true })).resolves.toEqual({
      messageId: 'slack-ts-2',
      media: undefined,
    });
    expect(post).toHaveBeenCalledTimes(1); // exactly one transport send — no double-text
  });

  it('a URL attachment is appended to the text (Slack unfurls) — no file upload', async () => {
    const store = { appendOutbound: vi.fn(async () => undefined) } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const post = vi.fn(async () => ({ id: 't-url' }));
    (gw as unknown as { activeThreads: Map<string, unknown> }).activeThreads.set(DM_THREAD, {
      post,
    });

    const result = await gw.send(DM_THREAD, {
      text: 'look at this',
      attachment: { pathOrUrl: 'https://example.com/pic.png' },
    });

    expect(post).toHaveBeenCalledWith('look at this\nhttps://example.com/pic.png');
    expect(result.media).toMatchObject({ url: 'https://example.com/pic.png', kind: 'image' });
  });
});

describe('send — required attachment (image-send-integrity)', () => {
  const media = MEDIA as unknown as { outboundReadyTimeoutMs: number; outboundReadyPollMs: number };
  let savedTimeout: number;
  let savedPoll: number;

  beforeEach(() => {
    savedTimeout = media.outboundReadyTimeoutMs;
    savedPoll = media.outboundReadyPollMs;
    media.outboundReadyTimeoutMs = 200;
    media.outboundReadyPollMs = 30;
  });

  afterEach(() => {
    media.outboundReadyTimeoutMs = savedTimeout;
    media.outboundReadyPollMs = savedPoll;
  });

  it('aborts the WHOLE send when the file never appears — no caption-only text', async () => {
    const appendOutbound = vi.fn(async () => undefined);
    const store = { appendOutbound } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const post = vi.fn(async () => ({ id: 't-img' }));
    (gw as unknown as { activeThreads: Map<string, unknown> }).activeThreads.set(DM_THREAD, {
      post,
    });

    const result = await gw.send(DM_THREAD, {
      text: 'the caption',
      attachment: { pathOrUrl: '/nonexistent/scene.jpg', required: true },
    });

    expect(result.mediaError).toBeDefined();
    expect(result.messageId).toBeUndefined();
    expect(post).not.toHaveBeenCalled();
    expect(appendOutbound).not.toHaveBeenCalled();
  });

  it('degrades a NON-required attachment to text, reporting the drop', async () => {
    const store = { appendOutbound: vi.fn(async () => undefined) } as unknown as ConversationStore;
    const gw = new SlackGateway({ config: slackConfig(), store });
    const post = vi.fn(async () => ({ id: 't-degraded' }));
    (gw as unknown as { activeThreads: Map<string, unknown> }).activeThreads.set(DM_THREAD, {
      post,
    });

    const result = await gw.send(DM_THREAD, {
      text: 'here is the chart',
      attachment: { pathOrUrl: '/nonexistent/chart.png' },
    });

    expect(post).toHaveBeenCalledWith('here is the chart'); // text still delivered
    expect(result.messageId).toBe('t-degraded');
    expect(result.mediaError).toBeDefined();
    expect(result.media).toBeUndefined();
  });
});
