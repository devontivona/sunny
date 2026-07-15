import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './db.js';
import { ShortLinker } from '../src/gateway/shortlinks.js';
import { shortLinks } from '../src/db/schema.js';
import handler from '../server/routes/s/[hash].get.js';
import { mockEvent } from 'nitro/h3';

const RUNTIME_KEY = Symbol.for('sunny.runtime');
const BASE = 'https://snny.ai';
const LONG = 'https://accounts.example.com/o/oauth2/auth?scope=a%20b&redirect_uri=http://localhost:1';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb.teardown();
});
afterEach(() => {
  delete process.env.SHORT_LINK_BASE_URL;
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_KEY];
});

describe('short links against a real database', () => {
  it('mints once, dedupes across sends, and resolves back', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    const linker = new ShortLinker(tdb.db);

    const first = await linker.rewrite(`auth here: ${LONG}`);
    const hash = first.match(/\/s\/(\w+)/)?.[1];
    expect(hash).toBeTruthy();
    expect(await linker.resolve(hash!)).toBe(LONG);

    // A later send of the same URL reuses the row.
    const second = await linker.rewrite(LONG);
    expect(second).toBe(`${BASE}/s/${hash}`);
    const rows = await tdb.db.select().from(shortLinks).where(eq(shortLinks.url, LONG));
    expect(rows).toHaveLength(1);
  });

  it('resolve rejects unknown and malformed hashes', async () => {
    const linker = new ShortLinker(tdb.db);
    expect(await linker.resolve('zzzzzz')).toBeNull(); // well-formed, absent
    expect(await linker.resolve('0OIl00')).toBeNull(); // lookalike glyphs — malformed
    expect(await linker.resolve('../etc')).toBeNull();
    expect(await linker.resolve('')).toBeNull();
  });
});

describe('GET /s/[hash] route', () => {
  function pinRuntime() {
    (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = Promise.resolve({ db: tdb.db });
  }

  async function call(hash: string) {
    const ev = mockEvent(`http://localhost/s/${hash}`, { method: 'GET' });
    (ev.context as { params?: Record<string, string> }).params = { hash };
    const body = await handler(ev);
    return { status: ev.res.status ?? 200, location: ev.res.headers.get('location'), body };
  }

  it('302s to the stored URL', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    pinRuntime();
    const short = await new ShortLinker(tdb.db).rewrite(LONG);
    const hash = short.match(/\/s\/(\w+)/)![1]!;
    const res = await call(hash);
    expect(res.status).toBe(302);
    expect(res.location).toBe(LONG);
  });

  it('404s on unknown and malformed hashes', async () => {
    pinRuntime();
    expect((await call('zzzzzz')).status).toBe(404);
    expect((await call('nope')).status).toBe(404);
  });
});
