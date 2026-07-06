import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { mockEvent } from 'nitro/h3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db.js';
import { makeConfig } from './factories.js';
import { FakeGateway } from './fakes/gateway.js';
import { accessRequests, messages } from '../src/db/schema.js';
import { AuthStore } from '../src/dashboard/auth/store.js';
import handler from '../server/routes/dashboard/api/[...].js';

/**
 * Route-level security regressions for the dashboard catch-all
 * (`server/routes/dashboard/api/[...].ts`). The handler pulls its db/config/gateway
 * from the memoized runtime singleton and its mode from env, so we pin a fake
 * runtime on the `Symbol.for('sunny.runtime')` slot and drive real h3 events with
 * `mockEvent`. Covers: S2 (approval must be a POST, never a state-changing GET),
 * S3 (media content-type allowlist / no inline stored XSS), S5 (rate-limit key
 * must not trust client X-Forwarded-For).
 */

const RUNTIME_KEY = Symbol.for('sunny.runtime');

let tdb: TestDb;
let gateway: FakeGateway;
let runtimeDir: string;
const savedEnv: Record<string, string | undefined> = {};

function stubEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(async () => {
  tdb = await createTestDb();
  gateway = new FakeGateway();
  runtimeDir = join(
    process.cwd(),
    'node_modules',
    '.cache',
    `dash-route-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(runtimeDir, 'media', 'inbound'), { recursive: true });
  const config = makeConfig({ runtimeDir });
  (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = Promise.resolve({
    db: tdb.db,
    config,
    gateway,
    store: {},
  });
});

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_KEY];
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  await tdb.teardown();
});

interface RouteResult {
  status: number;
  body: unknown;
  headers: Headers;
}

async function call(
  urlPath: string,
  method: string,
  headers: Record<string, string> = {},
): Promise<RouteResult> {
  const ev = mockEvent(`http://localhost/dashboard/api/${urlPath}`, { method, headers });
  const body = await handler(ev);
  return { status: ev.res.status ?? 200, body, headers: ev.res.headers };
}

describe('dashboard approval must not mutate on GET (S2)', () => {
  beforeEach(() =>
    stubEnv({ DASHBOARD_SESSION_SECRET: 'test-secret', DASHBOARD_DEV_OPEN: undefined }),
  );

  it('a GET to the approve URL renders a confirm form and does NOT approve', async () => {
    const store = new AuthStore(tdb.db);
    const req = await store.createRequest('Mac/Safari · 1.2.3.4');

    const res = await call(
      `auth/approve?rid=${req.id}&secret=${encodeURIComponent(req.secret)}`,
      'GET',
    );

    // The GET renders a confirm page with a POST form — it must not approve.
    // (Success path leaves the default status; only failures set 400.)
    expect(res.status).not.toBe(400);
    expect(String(res.body)).toContain('method="POST"');
    const [row] = await tdb.db.select().from(accessRequests).where(eq(accessRequests.id, req.id));
    expect(row?.status).toBe('pending');
  });

  it('only the POST actually approves the request', async () => {
    const store = new AuthStore(tdb.db);
    const req = await store.createRequest('Mac/Safari · 1.2.3.4');

    const res = await call(
      `auth/approve?rid=${req.id}&secret=${encodeURIComponent(req.secret)}`,
      'POST',
    );

    expect(res.status).not.toBe(400);
    expect(String(res.body)).toContain('Approved');
    const [row] = await tdb.db.select().from(accessRequests).where(eq(accessRequests.id, req.id));
    expect(row?.status).toBe('approved');
  });
});

describe('dashboard media content-type allowlist (S3)', () => {
  beforeEach(() => stubEnv({ DASHBOARD_DEV_OPEN: '1', DASHBOARD_SESSION_SECRET: undefined }));

  async function seedMediaRow(mediaType: string, ext: string): Promise<string> {
    const dir = join(runtimeDir, 'media', 'inbound', 'msg1');
    mkdirSync(dir, { recursive: true });
    const disk = join(dir, `0.${ext}`);
    writeFileSync(disk, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const [row] = await tdb.db
      .insert(messages)
      .values({
        channel: 'imessage',
        threadId: 'sendblue:owner:contact',
        messageId: `in-${Math.random()}`,
        role: 'user',
        senderId: '+15551230000',
        text: 'pic',
        isOwner: true,
        timestamp: new Date(),
        payload: {
          parts: [
            {
              type: 'data-attachment',
              data: {
                path: disk,
                mediaType,
                kind: 'image',
                name: `x.${ext}`,
                size: 10,
                direction: 'inbound',
              },
            },
          ],
        },
      })
      .returning();
    return row!.id;
  }

  it('an svg attachment is not served inline with an executable content-type', async () => {
    const id = await seedMediaRow('image/svg+xml', 'svg');
    const res = await call(`media?msg=${id}&i=0`, 'GET');

    expect(res.status).not.toBe(401);
    expect(res.headers.get('content-type')).not.toContain('svg');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment');
  });

  it('a png attachment is still served inline as image/png', async () => {
    const id = await seedMediaRow('image/png', 'png');
    const res = await call(`media?msg=${id}&i=0`, 'GET');

    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBeNull();
  });
});

describe('approval rate-limit ignores client X-Forwarded-For (S5)', () => {
  beforeEach(() =>
    stubEnv({ DASHBOARD_SESSION_SECRET: 'test-secret', DASHBOARD_DEV_OPEN: undefined }),
  );

  it('rotating X-Forwarded-For does not grant fresh rate-limit buckets', async () => {
    // Seed an owner DM so notifyOwner succeeds and each un-capped request sends.
    await tdb.db.insert(messages).values({
      channel: 'imessage',
      threadId: 'sendblue:owner:contact',
      messageId: 'seed-owner',
      role: 'user',
      senderId: '+15551230000',
      text: 'hi',
      isOwner: true,
      timestamp: new Date(),
    });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await call('auth/request', 'POST', {
        'x-forwarded-for': `10.0.0.${i}`,
        'user-agent': 'Mozilla/5.0 (Macintosh) Safari',
      });
      statuses.push(res.status);
    }

    // The 6th request (over the 5-per-window cap) must be throttled even though
    // every request carried a distinct X-Forwarded-For. If the limiter trusted
    // the header, each rotation would mint a fresh bucket and none would 429.
    expect(statuses[5]).toBe(429);
    expect(gateway.sent.length).toBe(5);
  });
});
