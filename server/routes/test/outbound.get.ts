import { defineEventHandler, getQuery } from 'nitro/h3';
import { getRuntime } from '../../../src/runtime.js';
import {
  LOOPBACK_DEFAULT_THREAD,
  asLoopback,
  testChannelAuthorized,
} from '../../../src/gateway/loopback.js';

/**
 * Read captured outbound from the loopback channel (durable-main-loop test infra) — what Sunny
 * delivered, for a script to poll after injecting a message. Returns the in-memory `sends`
 * buffer (immediate, exact per-`send_message` deliveries, in order) AND the persisted assistant
 * turns from the store (the durable D-MG9 record, robust across a restart). Same gating as
 * `/test/inbound`. Query: `threadId?`, `afterSeq?` (the cursor from inject / a prior read).
 */
export default defineEventHandler(async (event) => {
  if (process.env.SUNNY_TEST_CHANNEL !== '1') {
    return new Response('test channel disabled (set SUNNY_TEST_CHANNEL=1)', { status: 404 });
  }
  if (!testChannelAuthorized(event.req.headers.get('x-test-secret'))) {
    return new Response('unauthorized', { status: 401 });
  }
  const { gateway: rawGateway, store } = await getRuntime();
  const gateway = asLoopback(rawGateway);
  if (!gateway) {
    return new Response('runtime gateway is not the loopback channel', { status: 409 });
  }
  const q = getQuery(event);
  const threadId = typeof q.threadId === 'string' ? q.threadId : LOOPBACK_DEFAULT_THREAD;
  const afterSeq = Number(q.afterSeq ?? 0) || 0;

  const window = await store.recentWindow(threadId);
  const persisted = window
    .filter((m) => m.role === 'assistant')
    .slice(-5)
    .map((m) => ({ text: m.text, at: m.timestamp.toISOString() }));

  return {
    threadId,
    cursor: gateway.cursor(),
    sends: gateway.readOutbound(threadId, afterSeq),
    persisted,
    typingCount: gateway.typingCount(threadId), // typing refreshes fired this thread (5.5)
  };
});
