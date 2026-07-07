import type { ConversationStore } from './store.js';
import { logger } from '../logger.js';

const log = logger('delivery-tracker');

/**
 * Outbound delivery tracking (delivery-status-tracking, 2026-07-07) — closes the
 * phantom-send blind spot: Sendblue's REST 2xx means "accepted", not "delivered"; the real
 * outcome arrives asynchronously as an outbound status webhook that the chat adapter ignores
 * (and, on `service: null`, crashed on). The gateway intercepts those callbacks at OUR route
 * boundary — no adapter patching — and hands them here.
 *
 * On a terminal-failure status the tracker resends the IDENTICAL text (redelivery, never
 * regeneration — the duplicate-reply lesson: the composed text is fine, only the transport
 * failed) with bounded backoff. When retries are exhausted (or the resend itself cannot be
 * posted), it marks the persisted turn undelivered — so history stops claiming the person saw
 * a message they never got — and notifies the owner best-effort.
 *
 * Dedupe: Sendblue can deliver duplicate callbacks for one handle. `claimOutboundRetry` is a
 * conditional `sent → retrying` UPDATE, so exactly one callback per handle wins the retry;
 * each resend re-keys the row to the new handle, so stale-handle callbacks find nothing.
 * Pending backoff timers are in-process only: a restart drops them, and the row is left
 * `retrying` — visible in the table, surfaced by the failure log, but not auto-resumed
 * (deliberately simple; the next incident report can revisit).
 */

/** Sendblue statuses that mean the message will never arrive. */
const FAILURE_STATUSES = new Set(['ERROR', 'INTERNAL_ERROR', 'TIMEOUT', 'UNDELIVERED']);
/** Statuses that mean the transport accepted/delivered it (READ implies DELIVERED). */
const SUCCESS_STATUSES = new Set(['SENT', 'DELIVERED', 'READ']);

/** Total sends per logical message: the original + 3 retries. */
export const MAX_SEND_ATTEMPTS = 4;
/** Backoff before resend N (attempts=2,3,4). Both observed incidents were transient —
 *  later sends seconds after the failure succeeded — so the ladder starts short. */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/** The slice of Sendblue's outbound status callback the tracker reads. */
export interface OutboundStatusPayload {
  message_handle: string;
  status: string;
  error_message?: string;
}

/** True for the webhook bodies the gateway must intercept (the adapter ignores them). */
export function isOutboundStatusCallback(body: unknown): body is OutboundStatusPayload {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    b.is_outbound === true && typeof b.message_handle === 'string' && typeof b.status === 'string'
  );
}

export interface DeliveryTrackerDeps {
  store: Pick<
    ConversationStore,
    | 'registerOutboundDelivery'
    | 'outboundDeliveryByHandle'
    | 'markOutboundDelivered'
    | 'claimOutboundRetry'
    | 'completeOutboundRetry'
    | 'markOutboundFailed'
    | 'markTurnUndelivered'
  >;
  /** Post `text` to `threadId` again (raw transport send, no persist, no re-tracking);
   *  resolves to the new message_handle, or null when the provider returned none. */
  resend: (threadId: string, text: string) => Promise<string | null>;
  /** Best-effort owner notice on terminal failure. */
  notifyOwner: (text: string) => Promise<void>;
  /** Injectable delay (tests pass an immediate resolver). */
  wait?: (ms: number) => Promise<void>;
}

export class DeliveryTracker {
  constructor(private readonly deps: DeliveryTrackerDeps) {}

  /** Register a just-sent text so its status callback can be correlated. Best-effort. */
  async track(handle: string, threadId: string, text: string): Promise<void> {
    try {
      await this.deps.store.registerOutboundDelivery(handle, threadId, text);
    } catch (err) {
      log.warn('outbound tracking failed (send unaffected)', { threadId, err: String(err) });
    }
  }

  /** Handle one outbound status callback. Never throws (webhook already returned 200). */
  async handleStatus(payload: OutboundStatusPayload): Promise<void> {
    const { message_handle: handle, status } = payload;
    try {
      if (SUCCESS_STATUSES.has(status)) {
        await this.deps.store.markOutboundDelivered(handle, status);
        return;
      }
      if (!FAILURE_STATUSES.has(status)) {
        log.debug('unrecognized outbound status ignored', { handle, status });
        return;
      }
      await this.handleFailure(handle, status, payload.error_message);
    } catch (err) {
      log.error('outbound status handling failed', { handle, status, err: String(err) });
    }
  }

  private async handleFailure(handle: string, status: string, detail?: string): Promise<void> {
    const claimed = await this.deps.store.claimOutboundRetry(handle, status, MAX_SEND_ATTEMPTS);
    if (!claimed) {
      // No claim: unknown handle (untracked send), a duplicate callback (already `retrying`
      // or re-keyed), already failed — or out of attempts, the one case that needs action.
      const row = await this.deps.store.outboundDeliveryByHandle(handle);
      if (row && row.status === 'sent' && row.attempts >= MAX_SEND_ATTEMPTS) {
        await this.finalizeFailure(handle, status, row.threadId, row.text, row.attempts);
      } else {
        log.debug('failure callback not actionable', { handle, status, rowStatus: row?.status });
      }
      return;
    }

    // claimed.attempts already counts the resend we're about to perform.
    const delay = RETRY_DELAYS_MS[claimed.attempts - 2] ?? RETRY_DELAYS_MS.at(-1) ?? 0;
    log.warn('outbound delivery failed; retrying', {
      threadId: claimed.threadId,
      handle,
      status,
      detail,
      attempt: claimed.attempts,
      delayMs: delay,
    });
    await (this.deps.wait ?? defaultWait)(delay);

    try {
      const newHandle = await this.deps.resend(claimed.threadId, claimed.text);
      if (!newHandle) throw new Error('resend returned no message_handle');
      await this.deps.store.completeOutboundRetry(claimed.id, newHandle);
    } catch (err) {
      // The transport itself is refusing us — don't grind through more attempts blind.
      log.error('resend failed; marking undelivered', { handle, err: String(err) });
      await this.finalizeFailure(handle, status, claimed.threadId, claimed.text, claimed.attempts);
    }
  }

  /** Retries exhausted: record the terminal failure, fix history, tell the owner. */
  private async finalizeFailure(
    handle: string,
    status: string,
    threadId: string,
    text: string,
    attempts: number,
  ): Promise<void> {
    const row = await this.deps.store.markOutboundFailed(handle, status);
    if (!row) return; // another callback already finalized it
    log.error('outbound delivery failed terminally', { threadId, handle, status, attempts });

    // History honesty (the phantom-send fix): the persisted turn must stop claiming this
    // text was delivered, or the next turn "waits" on a reply to a message nobody received.
    const note =
      'DELIVERY FAILURE: this message was never delivered — the recipient has NOT seen it';
    const marked = await this.deps.store.markTurnUndelivered(threadId, text, note).catch((err) => {
      log.error('markTurnUndelivered failed', { threadId, err: String(err) });
      return false;
    });
    if (!marked) {
      log.warn('no persisted turn matched the failed text (history not marked)', { threadId });
    }

    const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    await this.deps
      .notifyOwner(
        `Heads up: an iMessage failed to deliver after ${attempts} attempts ` +
          `(thread ${threadId}, Sendblue status ${status}). The recipient never got: "${preview}"`,
      )
      .catch((err) => log.warn('owner notice failed', { err: String(err) }));
  }
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
