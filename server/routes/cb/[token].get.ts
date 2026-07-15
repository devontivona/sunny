import {
  defineEventHandler,
  getQuery,
  getRequestHeader,
  getRouterParam,
  setResponseHeader,
  setResponseStatus,
} from 'nitro/h3';
import { getRuntime } from '../../../src/runtime.js';
import { captureCallback } from '../../../src/gateway/callbacks.js';
import { appendInterRunMessage } from '../../../src/agent/delegation.js';
import { logger } from '../../../src/logger.js';

const log = logger('callbacks:route');

/**
 * Public OAuth-callback endpoint (callback-hosting spec). Necessarily
 * UNAUTHENTICATED — an OAuth provider's redirect arrives as a bare browser GET.
 * Safety model:
 *  - unguessable 128-bit token; malformed shapes rejected before any DB read,
 *  - single-capture: a conditional UPDATE means exactly one hit transitions the
 *    row and wakes Sunny; refreshes render "already done" with no re-wake,
 *  - unknown/expired/cancelled all render ONE non-committal page (no oracle),
 *  - captured parameter values never appear in the response page or the logs.
 *
 * A GET that mutates is deliberate here: the OAuth redirect IS a GET — that hit
 * is the event being captured. Link-preview prefetch of a /cb/ URL is not a real
 * concern because these URLs are handed to a provider as redirect_uri, not texted.
 */
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') ?? '';
  const { db, store, wakeThread } = await getRuntime();

  // Flatten the query into string params (arrays keep their first value).
  const raw = getQuery(event);
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    params[k] = String(Array.isArray(v) ? v[0] : (v ?? ''));
  }

  const result = await captureCallback(db, token, params, {
    ip: getRequestHeader(event, 'cf-connecting-ip') ?? null,
    userAgent: getRequestHeader(event, 'user-agent')?.slice(0, 200) ?? null,
    at: new Date().toISOString(),
  });

  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8');
  setResponseHeader(event, 'cache-control', 'no-store');

  if (result.outcome === 'captured') {
    const { row } = result;
    // Wake the originating thread with the captured params (the whole point):
    // same inbox-append + wake as a worker report; the model reads it as a
    // message from `oauth_callback`, never as the owner speaking.
    try {
      const text =
        `oauth_callback (system): callback '${row.label}' was hit; ` +
        `params: ${JSON.stringify(params)}`;
      await appendInterRunMessage(
        store,
        row.threadId,
        { id: 'oauth-callback', name: 'oauth_callback' },
        text,
      );
      wakeThread?.(row.threadId);
    } catch (err) {
      // The capture is durable — a failed wake is recoverable via the tool's
      // `check` action, so the human still gets their "done" page.
      log.error('callback captured but wake failed', {
        tokenPrefix: token.slice(0, 6),
        err: String(err),
      });
    }
    return page(
      'All set',
      'This step is complete — Sunny received the sign-in response. You can close this tab.',
    );
  }

  if (result.outcome === 'already-captured') {
    return page('Already done', 'This step was already completed. You can close this tab.');
  }

  // unknown / expired / cancelled — one non-committal page, deliberately vague.
  setResponseStatus(event, 404);
  return page('Link not active', 'This link is not active. If you were sent here, ask Sunny for a fresh one.');
});

/** Static, param-free page — captured values must never be echoed back (spec). */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100dvh; margin: 0; background: #fffbeb; color: #451a03; }
  main { text-align: center; padding: 2rem; max-width: 26rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0; line-height: 1.5; color: #78350f; }
  .sun { font-size: 2.2rem; display: block; margin-bottom: .75rem; }
</style>
</head>
<body><main><span class="sun">☀️</span><h1>${title}</h1><p>${body}</p></main></body>
</html>`;
}
