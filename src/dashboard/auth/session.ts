import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Session-cookie signing (web-dashboard D-WD4). The cookie carries
 * `${sessionId}.${HMAC(sessionId)}`. The DB row is the source of truth (revoked /
 * expiry are enforced there); the signature lets us reject tampered/forged
 * cookies without a DB hit and makes the opaque id unguessable-to-mint.
 */

const SEP = '.';

export function signSession(sessionId: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `${sessionId}${SEP}${sig}`;
}

/** Verify the cookie's signature and return the embedded session id, or null. */
export function verifySession(token: string, secret: string): string | null {
  const idx = token.lastIndexOf(SEP);
  if (idx <= 0) return null;
  const sessionId = token.slice(0, idx);
  const provided = token.slice(idx + 1);
  const expected = createHmac('sha256', secret).update(sessionId).digest('base64url');
  if (!constantTimeEqual(provided, expected)) return null;
  return sessionId;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
