import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/gateway/store.js';
import { MAX_SEND_ATTEMPTS } from '../src/gateway/deliveryTracker.js';
import { toModelMessages } from '../src/agent/turn.js';
import { createTestDb, type TestDb } from './db.js';

/**
 * Outbound delivery tracking against a real (PGlite) database (delivery-status-tracking,
 * 2026-07-07): the register → claim → complete/fail row lifecycle, the conditional-UPDATE
 * dedupe that lets exactly one status callback win a retry, and the history-honesty repair
 * (`markTurnUndelivered`) whose `data-delivery-failure` part must render into model history
 * as a bracketed note — the phantom-send fix.
 */
describe('outbound delivery tracking (store)', () => {
  let tdb: TestDb;
  let store: ConversationStore;
  const THREAD = 'sendblue:owner:kate';

  beforeEach(async () => {
    tdb = await createTestDb();
    store = new ConversationStore(tdb.db, 30);
  });
  afterEach(async () => {
    await tdb.teardown();
  });

  it('register → claim transitions sent→retrying once (duplicate callbacks lose)', async () => {
    await store.registerOutboundDelivery('h1', THREAD, 'hello kate');

    const first = await store.claimOutboundRetry('h1', 'INTERNAL_ERROR', MAX_SEND_ATTEMPTS);
    expect(first).toMatchObject({ status: 'retrying', attempts: 2, threadId: THREAD });

    // A duplicate callback for the same handle finds the row already `retrying` → no claim.
    expect(await store.claimOutboundRetry('h1', 'INTERNAL_ERROR', MAX_SEND_ATTEMPTS)).toBeNull();
  });

  it('completeOutboundRetry re-keys to the new handle; old-handle callbacks find nothing', async () => {
    await store.registerOutboundDelivery('h1', THREAD, 'hello kate');
    const claimed = await store.claimOutboundRetry('h1', 'ERROR', MAX_SEND_ATTEMPTS);
    await store.completeOutboundRetry(claimed!.id, 'h2');

    expect(await store.outboundDeliveryByHandle('h1')).toBeNull();
    expect(await store.outboundDeliveryByHandle('h2')).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
    // The re-keyed row can be claimed again under its new handle (retry 2).
    expect(await store.claimOutboundRetry('h2', 'ERROR', MAX_SEND_ATTEMPTS)).toMatchObject({
      attempts: 3,
    });
  });

  it('claims stop at the attempts cap', async () => {
    await store.registerOutboundDelivery('h1', THREAD, 'hello kate');
    let handle = 'h1';
    for (let i = 2; i <= MAX_SEND_ATTEMPTS; i++) {
      const claimed = await store.claimOutboundRetry(handle, 'ERROR', MAX_SEND_ATTEMPTS);
      expect(claimed?.attempts).toBe(i);
      handle = `h${i}`;
      await store.completeOutboundRetry(claimed!.id, handle);
    }
    // attempts now == MAX → no further claim; the tracker finalizes instead.
    expect(await store.claimOutboundRetry(handle, 'ERROR', MAX_SEND_ATTEMPTS)).toBeNull();
    const row = await store.markOutboundFailed(handle, 'ERROR');
    expect(row?.status).toBe('failed');
    // Finalize is once-only.
    expect(await store.markOutboundFailed(handle, 'ERROR')).toBeNull();
  });

  it('markOutboundDelivered records success', async () => {
    await store.registerOutboundDelivery('h1', THREAD, 'hello kate');
    await store.markOutboundDelivered('h1', 'DELIVERED');
    expect(await store.outboundDeliveryByHandle('h1')).toMatchObject({
      status: 'delivered',
      lastStatus: 'DELIVERED',
    });
  });

  it('markTurnUndelivered patches the matching turn row and the note renders into history', async () => {
    // A persisted conversational turn whose final text was the failed send (the Kate case).
    const finalText = 'Quick questions: 1. bracket? 2. mega backdoor? 3. savings target?';
    await store.appendTurn(
      THREAD,
      {
        role: 'assistant',
        parts: [{ type: 'text', text: finalText }],
        metadata: { delivered: 'text' },
      },
      finalText,
    );

    const marked = await store.markTurnUndelivered(
      THREAD,
      finalText,
      'DELIVERY FAILURE: this message was never delivered — the recipient has NOT seen it',
    );
    expect(marked).toBe(true);

    const window = await store.recentWindow(THREAD);
    const row = window.find((m) => m.role === 'assistant')!;
    const payload = row.payload as { metadata: { delivered: string }; parts: { type: string }[] };
    expect(payload.metadata.delivered).toBe('failed');
    expect(payload.parts.some((p) => p.type === 'data-delivery-failure')).toBe(true);

    // Read-time rendering: the model sees the failure as a bracketed fact after the text.
    const model = await toModelMessages(window, false);
    const assistant = model.find((m) => m.role === 'assistant')!;
    const rendered = JSON.stringify(assistant.content);
    expect(rendered).toContain('DELIVERY FAILURE');
    expect(rendered).toContain('never delivered');
  });

  it('markTurnUndelivered returns false when nothing matches (caller logs, no crash)', async () => {
    expect(await store.markTurnUndelivered(THREAD, 'text that was never persisted', 'note')).toBe(
      false,
    );
  });
});
