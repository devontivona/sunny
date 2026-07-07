import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryTracker,
  isOutboundStatusCallback,
  MAX_SEND_ATTEMPTS,
  type DeliveryTrackerDeps,
} from './deliveryTracker.js';
import type { OutboundDeliveryRow } from '../db/schema.js';

/** A minimal in-memory double of the store's outbound-delivery surface. */
function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const row = (extra: Partial<OutboundDeliveryRow> = {}): OutboundDeliveryRow => ({
    id: 'row-1',
    messageHandle: 'h1',
    threadId: 'sendblue:owner:kate',
    text: 'the three questions',
    status: 'sent',
    attempts: 2,
    lastStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });
  const store = {
    registerOutboundDelivery: vi.fn(async () => {}),
    outboundDeliveryByHandle: vi.fn(async () => null as OutboundDeliveryRow | null),
    markOutboundDelivered: vi.fn(async () => {}),
    claimOutboundRetry: vi.fn(async () => null as OutboundDeliveryRow | null),
    completeOutboundRetry: vi.fn(async () => {}),
    markOutboundFailed: vi.fn(async () => row({ status: 'failed' }) as OutboundDeliveryRow | null),
    markTurnUndelivered: vi.fn(async () => true),
    ...overrides,
  };
  const resend = vi.fn(async () => 'h2');
  const notifyOwner = vi.fn(async () => {});
  const deps = {
    store,
    resend,
    notifyOwner,
    wait: async () => {}, // no real backoff in tests
  } as unknown as DeliveryTrackerDeps;
  return { store, resend, notifyOwner, deps, row };
}

describe('isOutboundStatusCallback', () => {
  it('matches outbound status callbacks and nothing else', () => {
    expect(
      isOutboundStatusCallback({ is_outbound: true, message_handle: 'h', status: 'ERROR' }),
    ).toBe(true);
    // Inbound message webhook — must forward to the adapter untouched.
    expect(
      isOutboundStatusCallback({ is_outbound: false, message_handle: 'h', status: 'RECEIVED' }),
    ).toBe(false);
    // Typing webhook / junk.
    expect(isOutboundStatusCallback({ is_typing: true })).toBe(false);
    expect(isOutboundStatusCallback(null)).toBe(false);
    expect(isOutboundStatusCallback('ERROR')).toBe(false);
  });
});

describe('DeliveryTracker', () => {
  it('records success statuses without retrying', async () => {
    const { store, resend, deps } = makeDeps();
    await new DeliveryTracker(deps).handleStatus({ message_handle: 'h1', status: 'DELIVERED' });
    expect(store.markOutboundDelivered).toHaveBeenCalledWith('h1', 'DELIVERED');
    expect(store.claimOutboundRetry).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
  });

  it('a claimed failure resends the identical text and re-keys the row to the new handle', async () => {
    const { store, resend, notifyOwner, deps, row } = makeDeps();
    store.claimOutboundRetry.mockResolvedValueOnce(row({ status: 'retrying', attempts: 2 }));
    await new DeliveryTracker(deps).handleStatus({
      message_handle: 'h1',
      status: 'INTERNAL_ERROR',
    });
    expect(resend).toHaveBeenCalledWith('sendblue:owner:kate', 'the three questions');
    expect(store.completeOutboundRetry).toHaveBeenCalledWith('row-1', 'h2');
    expect(store.markOutboundFailed).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('an unclaimed duplicate callback does nothing (dedupe)', async () => {
    const { store, resend, deps, row } = makeDeps();
    store.claimOutboundRetry.mockResolvedValueOnce(null);
    store.outboundDeliveryByHandle.mockResolvedValueOnce(row({ status: 'retrying' }));
    await new DeliveryTracker(deps).handleStatus({ message_handle: 'h1', status: 'ERROR' });
    expect(resend).not.toHaveBeenCalled();
    expect(store.markOutboundFailed).not.toHaveBeenCalled();
  });

  it('exhausted attempts finalize: mark failed, repair history, notify the owner', async () => {
    const { store, resend, notifyOwner, deps, row } = makeDeps();
    store.claimOutboundRetry.mockResolvedValueOnce(null);
    store.outboundDeliveryByHandle.mockResolvedValueOnce(
      row({ status: 'sent', attempts: MAX_SEND_ATTEMPTS }),
    );
    await new DeliveryTracker(deps).handleStatus({ message_handle: 'h1', status: 'ERROR' });
    expect(resend).not.toHaveBeenCalled();
    expect(store.markOutboundFailed).toHaveBeenCalledWith('h1', 'ERROR');
    expect(store.markTurnUndelivered).toHaveBeenCalledWith(
      'sendblue:owner:kate',
      'the three questions',
      expect.stringContaining('DELIVERY FAILURE'),
    );
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining('failed to deliver'));
  });

  it('a resend that cannot be posted finalizes immediately (transport is down)', async () => {
    const { store, resend, notifyOwner, deps, row } = makeDeps();
    store.claimOutboundRetry.mockResolvedValueOnce(row({ status: 'retrying', attempts: 2 }));
    resend.mockRejectedValueOnce(new Error('sendblue 500'));
    await new DeliveryTracker(deps).handleStatus({ message_handle: 'h1', status: 'ERROR' });
    expect(store.markOutboundFailed).toHaveBeenCalled();
    expect(store.markTurnUndelivered).toHaveBeenCalled();
    expect(notifyOwner).toHaveBeenCalled();
  });

  it('finalize is idempotent: a second finalizer sees markOutboundFailed return null and stops', async () => {
    const { store, notifyOwner, deps, row } = makeDeps();
    store.claimOutboundRetry.mockResolvedValueOnce(null);
    store.outboundDeliveryByHandle.mockResolvedValueOnce(
      row({ status: 'sent', attempts: MAX_SEND_ATTEMPTS }),
    );
    store.markOutboundFailed.mockResolvedValueOnce(null);
    await new DeliveryTracker(deps).handleStatus({ message_handle: 'h1', status: 'ERROR' });
    expect(store.markTurnUndelivered).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('unknown handles are ignored (untracked sends, e.g. media)', async () => {
    const { store, resend, deps } = makeDeps();
    await new DeliveryTracker(deps).handleStatus({ message_handle: 'nope', status: 'ERROR' });
    expect(resend).not.toHaveBeenCalled();
    expect(store.markOutboundFailed).not.toHaveBeenCalled();
  });

  it('never throws out of handleStatus (webhook already answered 200)', async () => {
    const { store, deps } = makeDeps();
    store.markOutboundDelivered.mockRejectedValueOnce(new Error('db down'));
    await expect(
      new DeliveryTracker(deps).handleStatus({ message_handle: 'h1', status: 'DELIVERED' }),
    ).resolves.toBeUndefined();
  });
});
