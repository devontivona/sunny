import { defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from 'nitro/h3';
import { getRuntime } from '../../../src/runtime.js';
import { ShortLinker } from '../../../src/gateway/shortlinks.js';

/**
 * Public short-link redirect (short-links spec): `GET /s/<hash>` → 302 to the
 * stored long URL. Necessarily UNAUTHENTICATED — iMessage link previews and any
 * browser must be able to follow it with a bare GET (no cookies, no headers).
 * Unknown or malformed hashes 404 without leaking anything; malformed ones are
 * rejected by pattern before touching the DB.
 */
export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash') ?? '';
  const { db } = await getRuntime();

  const url = await new ShortLinker(db).resolve(hash);
  if (!url) {
    setResponseStatus(event, 404);
    return 'not found';
  }
  setResponseStatus(event, 302);
  setResponseHeader(event, 'location', url);
  // Permanent mapping, but keep caches short so a DB-side fix can propagate.
  setResponseHeader(event, 'cache-control', 'public, max-age=300');
  return '';
});
