import { randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { callbackEndpoints, type CallbackEndpointRow } from '../db/schema.js';
import { logger } from '../logger.js';
import { shortLinkBaseUrl } from './shortlinks.js';

const log = logger('gateway:callbacks');

export const CALLBACK_TTL_DEFAULT_MS = 30 * 60_000;
export const CALLBACK_TTL_MAX_MS = 24 * 60 * 60_000;

/** 16 random bytes, base64url ⇒ 22 chars. The route rejects other shapes without a DB hit. */
export const CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Captured query params can carry provider junk; cap what we store/relay. */
const MAX_PARAMS_JSON = 4096;

export interface MintedCallback {
  token: string;
  url: string;
  expiresAt: Date;
}

/**
 * Mint a public callback endpoint (callback-hosting spec): an unguessable
 * `<SHORT_LINK_BASE_URL>/cb/<token>` bound to the thread that gets woken on
 * capture. Fails loudly when the public base URL is not configured — a callback
 * URL that can never be reached is worse than an early error the model can relay.
 */
export async function mintCallback(
  db: Db,
  input: { threadId: string; label: string; ttlMs?: number },
): Promise<MintedCallback> {
  const base = shortLinkBaseUrl();
  if (!base) {
    throw new Error(
      'callback hosting needs SHORT_LINK_BASE_URL (the public snny.ai origin) in the environment',
    );
  }
  const ttlMs = Math.min(Math.max(input.ttlMs ?? CALLBACK_TTL_DEFAULT_MS, 60_000), CALLBACK_TTL_MAX_MS);
  const token = randomBytes(16).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(callbackEndpoints).values({
    token,
    threadId: input.threadId,
    label: input.label,
    ttlExpiresAt: expiresAt,
  });
  log.info('callback minted', { label: input.label, tokenPrefix: token.slice(0, 6), expiresAt });
  return { token, url: `${base}/cb/${token}`, expiresAt };
}

export type CaptureResult =
  | { outcome: 'captured'; row: CallbackEndpointRow }
  | { outcome: 'already-captured' }
  | { outcome: 'unknown' };

/**
 * Single-capture transition (callback-hosting spec): a conditional UPDATE
 * `pending → captured` that only one concurrent hit can win — the loser (and any
 * refresh) sees `already-captured`. Expired/cancelled/unknown all fold to
 * `unknown`, so the route can render one non-committal page for the three.
 * Captured params are stored, NEVER logged (short-lived OAuth codes).
 */
export async function captureCallback(
  db: Db,
  token: string,
  params: Record<string, string>,
  meta: Record<string, unknown>,
): Promise<CaptureResult> {
  if (!CALLBACK_TOKEN_PATTERN.test(token)) return { outcome: 'unknown' };
  const paramsValue: Record<string, unknown> =
    JSON.stringify(params).length > MAX_PARAMS_JSON
      ? { error: 'params too large; dropped', keys: Object.keys(params) }
      : params;
  const captured = await db
    .update(callbackEndpoints)
    .set({
      status: 'captured',
      capturedParams: paramsValue,
      capturedMeta: meta,
      capturedAt: new Date(),
    })
    .where(
      and(
        eq(callbackEndpoints.token, token),
        eq(callbackEndpoints.status, 'pending'),
        gt(callbackEndpoints.ttlExpiresAt, new Date()),
      ),
    )
    .returning();
  if (captured[0]) {
    log.info('callback captured', {
      label: captured[0].label,
      tokenPrefix: token.slice(0, 6),
      paramKeys: Object.keys(params),
    });
    return { outcome: 'captured', row: captured[0] };
  }
  // Didn't transition: either a second hit on a captured row (say so — the token
  // holder legitimately completed it) or pending-but-expired/cancelled/unknown
  // (all indistinguishable from outside, per spec).
  const rows = await db
    .select()
    .from(callbackEndpoints)
    .where(eq(callbackEndpoints.token, token))
    .limit(1);
  if (rows[0]?.status === 'captured') return { outcome: 'already-captured' };
  return { outcome: 'unknown' };
}

export type CallbackStatus = 'pending' | 'captured' | 'cancelled' | 'expired' | 'unknown';

export interface CallbackCheck {
  status: CallbackStatus;
  label?: string;
  expiresAt?: Date;
  capturedAt?: Date | null;
  /** Present only when captured — the redirect's query params, for the model to act on. */
  params?: unknown;
}

/** Status for the tool's `check` action. Expiry is judged at read time. */
export async function checkCallback(db: Db, token: string): Promise<CallbackCheck> {
  if (!CALLBACK_TOKEN_PATTERN.test(token)) return { status: 'unknown' };
  const rows = await db
    .select()
    .from(callbackEndpoints)
    .where(eq(callbackEndpoints.token, token))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'unknown' };
  const expired = row.status === 'pending' && row.ttlExpiresAt.getTime() <= Date.now();
  return {
    status: expired ? 'expired' : (row.status as CallbackStatus),
    label: row.label,
    expiresAt: row.ttlExpiresAt,
    capturedAt: row.capturedAt,
    ...(row.status === 'captured' ? { params: row.capturedParams } : {}),
  };
}

/** Deactivate a pending callback (tool `cancel`). A cancelled endpoint captures nothing. */
export async function cancelCallback(db: Db, token: string): Promise<boolean> {
  if (!CALLBACK_TOKEN_PATTERN.test(token)) return false;
  const rows = await db
    .update(callbackEndpoints)
    .set({ status: 'cancelled' })
    .where(and(eq(callbackEndpoints.token, token), eq(callbackEndpoints.status, 'pending')))
    .returning({ token: callbackEndpoints.token });
  return rows.length > 0;
}
