import { defineEventHandler } from 'nitro/h3';
import type { MockResponseDescriptor } from '@workflow/ai/test';
import { getRuntime } from '../../../src/runtime.js';
import {
  asLoopback,
  testChannelAuthorized,
  LOOPBACK_DEFAULT_THREAD,
} from '../../../src/gateway/loopback.js';
import { setTestModelResponses } from '../../../src/agent/turnModel.js';

/**
 * Inject an inbound message through the programmatic loopback channel (durable-main-loop test
 * infra) — exercises the FULL pipeline (persist → router → turn-run → delivery) without
 * Sendblue, so turns can be driven from a script. Gated by `SUNNY_TEST_CHANNEL=1` AND an
 * `x-test-secret` header matching `SUNNY_TEST_SECRET` (message injection is never open).
 *
 * Body: `{ text, threadId?, senderId?, senderName?, modelResponses? }`. When `modelResponses`
 * (a `mockSequenceModel` descriptor array) is provided, the durable turn runs DETERMINISTICALLY
 * against that mock (via the `getTurnModel` seam); omit it for a real-model turn. Returns
 * `{ messageId, threadId, cursor }` — poll `GET /test/outbound?threadId&afterSeq=cursor` for the reply.
 */
const TEST_TURN_MODEL = Symbol.for('sunny.testTurnModel');

export default defineEventHandler(async (event) => {
  if (process.env.SUNNY_TEST_CHANNEL !== '1') {
    return new Response('test channel disabled (set SUNNY_TEST_CHANNEL=1)', { status: 404 });
  }
  if (!testChannelAuthorized(event.req.headers.get('x-test-secret'))) {
    return new Response('unauthorized (set SUNNY_TEST_SECRET + x-test-secret header)', {
      status: 401,
    });
  }
  const gateway = asLoopback((await getRuntime()).gateway);
  if (!gateway) {
    return new Response('runtime gateway is not the loopback channel', { status: 409 });
  }
  const body = (await event.req.json().catch(() => ({}))) as {
    text?: string;
    threadId?: string;
    senderId?: string;
    senderName?: string;
    modelResponses?: unknown[];
  };
  if (typeof body.text !== 'string' || !body.text.trim()) {
    return new Response('body.text is required', { status: 400 });
  }
  // Deterministic-turn seam: script (or clear) the mock responses for THIS thread, keyed +
  // consumed once in `setupTurn` (steps run in this process). Keying by threadId means the mock
  // only ever drives its own turn — never a concurrent real-model turn or a recovery/drain turn.
  // Omitting `modelResponses` reverts the thread to the real model.
  const threadId = body.threadId ?? LOOPBACK_DEFAULT_THREAD;
  setTestModelResponses(
    threadId,
    Array.isArray(body.modelResponses)
      ? (body.modelResponses as MockResponseDescriptor[])
      : undefined,
  );

  return gateway.injectInbound({
    text: body.text,
    threadId: body.threadId,
    senderId: body.senderId,
    senderName: body.senderName,
  });
});
