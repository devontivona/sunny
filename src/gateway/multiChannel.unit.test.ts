import { describe, expect, it, vi } from 'vitest';
import { MultiChannelGateway } from './multiChannel.js';
import type { LoopbackGateway } from './loopback.js';
import type { Gateway, InboundHandler, SendResult } from './types.js';

/**
 * Multi-channel routing guards (add-slack-channel, task 4.2 / messaging-gateway
 * "Per-channel webhook dispatch"): outbound routes by thread-id prefix, webhooks
 * resolve per channel via driverFor, and every sub-gateway's inbound reaches the
 * single registered handler.
 */

function fakeGateway(channel: string): Gateway & {
  sends: string[];
  webhooks: number;
  handlers: InboundHandler[];
} {
  const g = {
    channel,
    capabilities: {
      reactions: false,
      readReceipts: false,
      typing: true,
      groups: false,
      proactiveGroup: false,
      media: true,
    },
    sends: [] as string[],
    webhooks: 0,
    handlers: [] as InboundHandler[],
    onInbound(handler: InboundHandler) {
      g.handlers.push(handler);
    },
    async send(threadId: string): Promise<SendResult> {
      g.sends.push(threadId);
      return { messageId: `${channel}-1` };
    },
    async startTyping() {},
    async start() {},
    async handleWebhook(): Promise<Response> {
      g.webhooks += 1;
      return new Response(channel, { status: 200 });
    },
  };
  return g;
}

const wire = () => {
  const primary = fakeGateway('imessage');
  const slack = fakeGateway('slack');
  const loopback = fakeGateway('loopback') as unknown as LoopbackGateway & {
    sends: string[];
    webhooks: number;
  };
  const multi = new MultiChannelGateway(primary, { slack, loopback });
  return { primary, slack, loopback, multi };
};

describe('MultiChannelGateway — outbound routing by thread-id prefix', () => {
  it('routes slack: threads to the Slack driver, loopback: to loopback, rest to primary', async () => {
    const { primary, slack, loopback, multi } = wire();

    await multi.send('slack:D0AAA:1.2', { text: 'x' });
    await multi.send('loopback:test:devon', { text: 'x' });
    await multi.send('sendblue:owner:contact', { text: 'x' });

    expect(slack.sends).toEqual(['slack:D0AAA:1.2']);
    expect((loopback as unknown as { sends: string[] }).sends).toEqual(['loopback:test:devon']);
    expect(primary.sends).toEqual(['sendblue:owner:contact']);
  });

  it('falls back to primary for a slack: thread when no Slack driver is wired', async () => {
    const primary = fakeGateway('imessage');
    const multi = new MultiChannelGateway(primary, {});
    await multi.send('slack:D0AAA:1.2', { text: 'x' });
    expect(primary.sends).toEqual(['slack:D0AAA:1.2']);
  });
});

describe('MultiChannelGateway — per-channel webhook dispatch', () => {
  it('driverFor resolves each channel to its own driver (and undefined when absent)', () => {
    const { primary, slack, loopback, multi } = wire();
    expect(multi.driverFor('slack')).toBe(slack);
    expect(multi.driverFor('loopback')).toBe(loopback);
    expect(multi.driverFor('imessage')).toBe(primary);
    expect(multi.driverFor('telegram')).toBeUndefined();

    const bare = new MultiChannelGateway(fakeGateway('imessage'), {});
    expect(bare.driverFor('slack')).toBeUndefined();
  });

  it('a webhook dispatched via driverFor reaches ONLY that channel driver', async () => {
    const { primary, slack, multi } = wire();

    const res = await multi
      .driverFor('slack')!
      .handleWebhook(new Request('https://x/webhooks/slack', { method: 'POST' }));
    expect(await res.text()).toBe('slack');
    expect(slack.webhooks).toBe(1);
    expect(primary.webhooks).toBe(0);
  });

  it('the bare gateway.handleWebhook stays the primary transport (back-compat)', async () => {
    const { primary, slack, multi } = wire();
    await multi.handleWebhook(new Request('https://x/webhooks/sendblue', { method: 'POST' }));
    expect(primary.webhooks).toBe(1);
    expect(slack.webhooks).toBe(0);
  });
});

describe('MultiChannelGateway — inbound fan-in', () => {
  it('registers the single handler on primary AND every extra', () => {
    const { primary, slack, loopback, multi } = wire();
    const handler = vi.fn();
    multi.onInbound(handler);
    expect(primary.handlers).toEqual([handler]);
    expect(slack.handlers).toEqual([handler]);
    expect((loopback as unknown as { handlers: InboundHandler[] }).handlers).toEqual([handler]);
  });
});
