import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendblueGateway, normalizeDateSent } from './sendblue.js';
import type { ConversationStore } from './store.js';
import type { ChannelEvent } from './types.js';
import { makeConfig, OWNER_PHONE, OWNER_THREAD } from '../../tests/factories.js';

/**
 * Sendblue gateway guards (code-review sweep):
 *  - S1: the constructor hard-requires SENDBLUE_WEBHOOK_SECRET so inbound webhook
 *    verification is always on (a missing secret makes the adapter skip verification,
 *    letting anyone who finds the URL POST a spoofed owner inbound).
 *  - InvalidDate: an inbound whose `dateSent` is an Invalid Date must normalize to a
 *    valid timestamp instead of flowing to `.toISOString()` and dropping the message.
 *  - R10-send: a persist failure AFTER a successful transport send must not propagate
 *    (a retried WDK step would re-send and text the user twice).
 */

const REQUIRED_ENV = {
  SENDBLUE_API_KEY: 'k',
  SENDBLUE_API_SECRET: 's',
  SENDBLUE_FROM_NUMBER: '+15550000000',
  SENDBLUE_WEBHOOK_SECRET: 'whsec',
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

describe('SendblueGateway constructor — required secrets (S1)', () => {
  const config = makeConfig();
  const store = {} as ConversationStore;

  it('throws when SENDBLUE_WEBHOOK_SECRET is missing (verification must always be on)', () => {
    delete process.env.SENDBLUE_WEBHOOK_SECRET;
    expect(() => new SendblueGateway({ config, store })).toThrow(/SENDBLUE_WEBHOOK_SECRET/);
  });

  it('constructs when every secret (incl. the webhook secret) is present', () => {
    expect(() => new SendblueGateway({ config, store })).not.toThrow();
  });
});

describe('normalizeDateSent (InvalidDate)', () => {
  it('passes a valid date through unchanged', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(normalizeDateSent(d)).toBe(d);
  });

  it('replaces an Invalid Date with a valid one', () => {
    const invalid = new Date('not-a-date');
    expect(Number.isNaN(invalid.getTime())).toBe(true);
    const out = normalizeDateSent(invalid);
    expect(Number.isNaN(out.getTime())).toBe(false);
  });

  it('replaces undefined with a valid one', () => {
    expect(Number.isNaN(normalizeDateSent(undefined).getTime())).toBe(false);
  });
});

describe('dispatch — inbound with an Invalid Date (InvalidDate)', () => {
  it('normalizes an Invalid dateSent to a valid timestamp (no throw, message not dropped)', async () => {
    const config = makeConfig({ owner: { name: 'Devon', identities: [OWNER_PHONE] } });
    const appendInbound = vi.fn(async () => true);
    const store = { appendInbound } as unknown as ConversationStore;
    const gw = new SendblueGateway({ config, store });

    let captured: ChannelEvent | undefined;
    gw.onInbound(async (event) => {
      captured = event;
    });

    const message = {
      id: 'in-1',
      text: 'hi',
      author: { isMe: false, userId: OWNER_PHONE, fullName: 'Devon' },
      attachments: [],
      // The adapter builds this via `new Date(raw.date_sent)`; a malformed date_sent yields
      // a non-nullish Invalid Date that `?? new Date()` does NOT catch.
      metadata: { dateSent: new Date('garbage') },
    };
    const thread = { id: OWNER_THREAD };

    await expect(
      (gw as unknown as { dispatch(t: unknown, m: unknown): Promise<void> }).dispatch(
        thread,
        message,
      ),
    ).resolves.toBeUndefined();

    expect(appendInbound).toHaveBeenCalledTimes(1);
    const persistedEvent = (appendInbound.mock.calls[0] as unknown as [ChannelEvent])[0];
    expect(Number.isNaN(persistedEvent.timestamp.getTime())).toBe(false);
    expect(captured).toBeDefined();
    expect(Number.isNaN(captured!.timestamp.getTime())).toBe(false);
  });
});

describe('doSend — persist failure after a successful send (R10-send)', () => {
  it('does not re-throw when appendOutbound rejects after delivery; sends exactly once', async () => {
    const config = makeConfig();
    const appendOutbound = vi.fn().mockRejectedValue(new Error('db down after send'));
    const store = { appendOutbound } as unknown as ConversationStore;
    const gw = new SendblueGateway({ config, store });

    // A live thread handle so doSend takes the `thread.post` path and gets a stable
    // provider-returned message id (the id the idempotent appendOutbound dedups on).
    const post = vi.fn(async () => ({ id: 'provider-123' }));
    (gw as unknown as { activeThreads: Map<string, unknown> }).activeThreads.set(OWNER_THREAD, {
      post,
    });

    // The persist:true path is the retried WDK step; a propagated error would re-run it.
    await expect(gw.send(OWNER_THREAD, { text: 'hello' }, { persist: true })).resolves.toEqual({
      messageId: 'provider-123',
      media: undefined,
    });

    // Transport send happened exactly once — no double-text.
    expect(post).toHaveBeenCalledTimes(1);
    // We attempted to persist with the STABLE provider id (so a retry would dedup).
    expect(appendOutbound).toHaveBeenCalledTimes(1);
    expect(appendOutbound.mock.calls[0]![1]).toBe('provider-123');
  });
});
