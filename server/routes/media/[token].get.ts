import { readFileSync, statSync } from 'node:fs';
import { defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from 'nitro/h3';
import { getRuntime } from '../../../src/runtime.js';
import { MEDIA, contentTypeForName, resolveOutbox } from '../../../src/gateway/media.js';
import { logger } from '../../../src/logger.js';

const log = logger('media');

/**
 * Public outbound-media route (messaging-media D-MM4). Sendblue fetches an
 * outbound `media_url` server-side and so cannot present a session — this route
 * is necessarily UNAUTHENTICATED. Its safety comes entirely from:
 *  - an unguessable 128-bit token in the filename (validated by `resolveOutbox`),
 *  - serving ONLY the fixed outbox dir, never a caller-supplied path (no traversal),
 *  - a short TTL: an expired file 404s and is swept by the cleanup task.
 * It is never a general, path-addressable file server.
 */
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'token') ?? '';
  const { config } = await getRuntime();

  const path = resolveOutbox(config.runtimeDir, name);
  if (!path) {
    setResponseStatus(event, 404);
    return 'not found';
  }
  // Expire by age even before the sweep deletes the file (D-MM4).
  try {
    if (Date.now() - statSync(path).mtimeMs > MEDIA.outboxTtlMs) {
      setResponseStatus(event, 404);
      return 'not found';
    }
  } catch {
    setResponseStatus(event, 404);
    return 'not found';
  }

  try {
    const bytes = readFileSync(path);
    setResponseHeader(event, 'content-type', contentTypeForName(name));
    setResponseHeader(event, 'cache-control', 'private, max-age=60');
    return bytes;
  } catch (err) {
    log.warn('failed to read outbox file', { err: String(err) });
    setResponseStatus(event, 404);
    return 'not found';
  }
});
