import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mockEvent } from 'nitro/h3';
import { createTestDb, type TestDb } from './db.js';
import { makeConfig } from './factories.js';
import {
  cancelCallback,
  captureCallback,
  checkCallback,
  mintCallback,
} from '../src/gateway/callbacks.js';
import { callbackEndpoints } from '../src/db/schema.js';
import { toolCatalog } from '../src/agent/tools/catalog.js';
import { OAUTH_CALLBACK_SPEC } from '../src/agent/tools/oauthCallbackSpec.js';
import handler from '../server/routes/cb/[token].get.js';
import type { ChannelEvent } from '../src/gateway/types.js';

const RUNTIME_KEY = Symbol.for('sunny.runtime');
const THREAD = 'imessage:dm:+1000:+1001';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
  process.env.SHORT_LINK_BASE_URL = 'https://snny.ai';
});
afterAll(async () => {
  delete process.env.SHORT_LINK_BASE_URL;
  await tdb.teardown();
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_KEY];
});

async function expireNow(token: string) {
  await tdb.db
    .update(callbackEndpoints)
    .set({ ttlExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(callbackEndpoints.token, token));
}

describe('callback lifecycle (single-capture, expiry, cancel)', () => {
  it('mints a live URL and captures exactly once — concurrent hits race to one winner', async () => {
    const minted = await mintCallback(tdb.db, { threadId: THREAD, label: 'race test' });
    expect(minted.url).toBe(`https://snny.ai/cb/${minted.token}`);

    const results = await Promise.all([
      captureCallback(tdb.db, minted.token, { code: 'first' }, {}),
      captureCallback(tdb.db, minted.token, { code: 'second' }, {}),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['already-captured', 'captured']);

    // The stored params belong to the WINNER — the loser must not overwrite.
    const check = await checkCallback(tdb.db, minted.token);
    expect(check.status).toBe('captured');
    const winner = results.find((r) => r.outcome === 'captured')!;
    expect(check.params).toEqual(
      (winner as { row: { capturedParams: unknown } }).row.capturedParams,
    );
  });

  it('an expired callback captures nothing and checks as expired', async () => {
    const minted = await mintCallback(tdb.db, { threadId: THREAD, label: 'expiry test' });
    await expireNow(minted.token);
    expect((await captureCallback(tdb.db, minted.token, { code: 'x' }, {})).outcome).toBe(
      'unknown',
    );
    expect((await checkCallback(tdb.db, minted.token)).status).toBe('expired');
  });

  it('cancel deactivates: a later hit is unknown, a second cancel is a no-op', async () => {
    const minted = await mintCallback(tdb.db, { threadId: THREAD, label: 'cancel test' });
    expect(await cancelCallback(tdb.db, minted.token)).toBe(true);
    expect((await captureCallback(tdb.db, minted.token, { code: 'x' }, {})).outcome).toBe(
      'unknown',
    );
    expect(await cancelCallback(tdb.db, minted.token)).toBe(false);
    expect((await checkCallback(tdb.db, minted.token)).status).toBe('cancelled');
  });

  it('rejects malformed tokens before touching the database', async () => {
    expect((await captureCallback(tdb.db, 'short', { a: '1' }, {})).outcome).toBe('unknown');
    expect((await checkCallback(tdb.db, '../../etc/passwd')).status).toBe('unknown');
    expect(await cancelCallback(tdb.db, '')).toBe(false);
  });

  it('mint fails loudly without SHORT_LINK_BASE_URL', async () => {
    delete process.env.SHORT_LINK_BASE_URL;
    await expect(mintCallback(tdb.db, { threadId: THREAD, label: 'x' })).rejects.toThrow(
      /SHORT_LINK_BASE_URL/,
    );
    process.env.SHORT_LINK_BASE_URL = 'https://snny.ai';
  });
});

describe('GET /cb/[token] route', () => {
  function pinRuntime() {
    const appended: ChannelEvent[] = [];
    const wakes: string[] = [];
    (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = Promise.resolve({
      db: tdb.db,
      config: makeConfig(),
      store: {
        appendInbound: async (event: ChannelEvent) => {
          appended.push(event);
          return true;
        },
      },
      wakeThread: vi.fn((t: string) => wakes.push(t)),
    });
    return { appended, wakes };
  }

  async function call(token: string, query = '') {
    const ev = mockEvent(`http://localhost/cb/${token}${query}`, { method: 'GET' });
    (ev.context as { params?: Record<string, string> }).params = { token };
    const body = String(await handler(ev));
    return { status: ev.res.status ?? 200, body };
  }

  it('first hit captures, renders the done page without param values, and wakes the thread', async () => {
    const { appended, wakes } = pinRuntime();
    const minted = await mintCallback(tdb.db, { threadId: THREAD, label: 'gcloud login' });

    const res = await call(minted.token, '?code=4%2F0AdkSECRET&state=xyz');
    expect(res.status).toBe(200);
    expect(res.body).toContain('close this tab');
    expect(res.body).not.toContain('AdkSECRET'); // captured values never echoed

    expect(wakes).toEqual([THREAD]);
    expect(appended).toHaveLength(1);
    const woke = appended[0]!;
    expect(woke.threadId).toBe(THREAD);
    expect(woke.isOwner).toBe(false); // never mistakable for the owner speaking
    expect(woke.text).toContain('gcloud login');
    expect(woke.text).toContain('4/0AdkSECRET'); // the wake message DOES carry the params
    expect(woke.text).toContain('"state":"xyz"');
  });

  it('a refresh renders already-done and does NOT re-wake or overwrite', async () => {
    const { appended, wakes } = pinRuntime();
    const minted = await mintCallback(tdb.db, { threadId: THREAD, label: 'refresh test' });
    await call(minted.token, '?code=real');
    const again = await call(minted.token, '?code=attacker-overwrite');
    expect(again.status).toBe(200);
    expect(again.body).toContain('Already done');
    expect(wakes).toHaveLength(1);
    expect(appended).toHaveLength(1);
    const check = await checkCallback(tdb.db, minted.token);
    expect(check.params).toEqual({ code: 'real' });
  });

  it('unknown, expired, and cancelled tokens render the SAME non-committal page', async () => {
    pinRuntime();
    const expired = await mintCallback(tdb.db, { threadId: THREAD, label: 'exp' });
    await expireNow(expired.token);
    const cancelled = await mintCallback(tdb.db, { threadId: THREAD, label: 'can' });
    await cancelCallback(tdb.db, cancelled.token);

    const unknownRes = await call('AAAAAAAAAAAAAAAAAAAAAA');
    const expiredRes = await call(expired.token);
    const cancelledRes = await call(cancelled.token);
    expect(unknownRes).toEqual(expiredRes);
    expect(expiredRes).toEqual(cancelledRes);
    expect(unknownRes.status).toBe(404);
  });
});

describe('tool catalog parity', () => {
  it('oauth_callback is listed trusted-DM-only with the live spec', () => {
    const entries = toolCatalog(makeConfig());
    const entry = entries.find((e) => e.name === 'oauth_callback');
    expect(entry).toBeDefined();
    expect(entry!.ownerOnly).toBe(true);
    // Purpose is distilled from the SAME spec buildTools registers (first sentence).
    expect(OAUTH_CALLBACK_SPEC.description.startsWith(entry!.purpose.replace(/…$/, ''))).toBe(
      true,
    );
    expect(entry!.params.map((p: { name: string }) => p.name).sort()).toEqual([
      'action',
      'label',
      'token',
      'ttl_minutes',
    ]);
  });
});
