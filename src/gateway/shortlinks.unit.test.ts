import { afterEach, describe, expect, it } from 'vitest';
import { extractUrls, shortLinkBaseUrl, ShortLinker, HASH_PATTERN } from './shortlinks.js';
import type { Db } from '../db/client.js';

const BASE = 'https://snny.ai';

afterEach(() => {
  delete process.env.SHORT_LINK_BASE_URL;
});

describe('extractUrls', () => {
  it('finds plain URLs and strips sentence punctuation', () => {
    expect(extractUrls('see https://example.com/a.')).toEqual(['https://example.com/a']);
    expect(extractUrls('go to https://example.com/a, then stop')).toEqual([
      'https://example.com/a',
    ]);
    expect(extractUrls('really? https://example.com/a?q=1!')).toEqual([
      'https://example.com/a?q=1',
    ]);
    expect(extractUrls('"https://example.com/a"')).toEqual(['https://example.com/a']);
    expect(extractUrls("'https://example.com/a';")).toEqual(['https://example.com/a']);
  });

  it('keeps balanced parens/brackets but peels unbalanced ones', () => {
    expect(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
    expect(extractUrls('(see https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(extractUrls('[link: https://example.com/a]')).toEqual(['https://example.com/a']);
  });

  it('finds multiple URLs and both schemes', () => {
    expect(extractUrls('a https://x.com/1 b http://y.com/2 c')).toEqual([
      'https://x.com/1',
      'http://y.com/2',
    ]);
  });

  it('matches nothing in plain text', () => {
    expect(extractUrls('no links here, https:// is not a url')).toEqual([]);
  });

  it('a URL with embedded URLs is ONE url, not several (real Google auth link, 2026-06-30)', () => {
    // Verbatim from Sunny's message history: the Drive/Calendar re-auth link whose
    // `scope` param carries five literal `https://` URLs and whose redirect_uri is
    // another embedded URL. The extractor must swallow the whole run as one URL —
    // splitting it would break the link AND mint garbage hashes.
    const auth =
      'https://accounts.google.com/o/oauth2/auth?scope=https://www.googleapis.com/auth/drive%20' +
      'https://www.googleapis.com/auth/calendar%20https://www.googleapis.com/auth/tasks%20openid%20' +
      'https://www.googleapis.com/auth/userinfo.email%20https://www.googleapis.com/auth/userinfo.profile' +
      '&access_type=offline&redirect_uri=http://localhost:35985&response_type=code' +
      '&client_id=809375495124-89c32no7c55limm2qdgok1fh8voec1bh.apps.googleusercontent.com' +
      '&prompt=select_account+consent';
    expect(extractUrls(`Tap to sign in: ${auth}`)).toEqual([auth]);
    // Same shape on the way back: the localhost callback the user pastes carries the
    // issuer URL and code as query params.
    const cb = 'http://localhost:36061/?iss=https://accounts.google.com&code=4/0AdkVLPz&scope=email';
    expect(extractUrls(cb)).toEqual([cb]);
  });
});

describe('shortLinkBaseUrl', () => {
  it('is undefined when unset or blank, and strips trailing slashes', () => {
    expect(shortLinkBaseUrl()).toBeUndefined();
    process.env.SHORT_LINK_BASE_URL = '  ';
    expect(shortLinkBaseUrl()).toBeUndefined();
    process.env.SHORT_LINK_BASE_URL = 'https://snny.ai/';
    expect(shortLinkBaseUrl()).toBe('https://snny.ai');
  });
});

/** Scriptable stand-in for the two Drizzle call chains ShortLinker uses. */
function stubDb(script: {
  selectResults?: Array<Array<{ hash: string }>>;
  insertResults?: Array<Array<{ hash: string }>>;
  selectThrows?: boolean;
}) {
  const calls = { selects: 0, inserts: 0 };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            calls.selects++;
            if (script.selectThrows) throw new Error('db down');
            return script.selectResults?.shift() ?? [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: { hash: string }) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            calls.inserts++;
            const next = script.insertResults?.shift();
            // Default: the insert succeeds with the minted hash.
            return next ?? [{ hash: v.hash }];
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { db, calls };
}

describe('ShortLinker.rewrite', () => {
  it('is a byte-identical no-op when SHORT_LINK_BASE_URL is unset', async () => {
    const { db, calls } = stubDb({});
    const text = 'see https://example.com/very/long/url?with=params';
    expect(await new ShortLinker(db).rewrite(text)).toBe(text);
    expect(calls.selects + calls.inserts).toBe(0);
  });

  it('replaces every URL with a minted short link', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    const { db } = stubDb({});
    const out = await new ShortLinker(db).rewrite('go to https://example.com/x now');
    const m = out.match(/^go to https:\/\/snny\.ai\/s\/(\S+) now$/);
    expect(m).not.toBeNull();
    expect(HASH_PATTERN.test(m![1]!)).toBe(true);
  });

  it('replaces a repeated URL everywhere with ONE mint', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    const { db, calls } = stubDb({});
    const out = await new ShortLinker(db).rewrite(
      'https://example.com/x and again https://example.com/x',
    );
    const links = out.match(/https:\/\/snny\.ai\/s\/\w+/g) ?? [];
    expect(links).toHaveLength(2);
    expect(links[0]).toBe(links[1]);
    expect(calls.inserts).toBe(1);
  });

  it('reuses an existing hash for a previously-shortened URL (dedupe)', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    const { db, calls } = stubDb({ selectResults: [[{ hash: 'Known1' }]] });
    const out = await new ShortLinker(db).rewrite('https://example.com/x');
    expect(out).toBe(`${BASE}/s/Known1`);
    expect(calls.inserts).toBe(0);
  });

  it('leaves our own short links untouched', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    const { db, calls } = stubDb({});
    const text = `already short: ${BASE}/s/Ab3xYz`;
    expect(await new ShortLinker(db).rewrite(text)).toBe(text);
    expect(calls.selects + calls.inserts).toBe(0);
  });

  it('retries on hash collision (insert conflicted, url absent) until it lands', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    const { db, calls } = stubDb({
      // initial dedupe-select miss, then the post-conflict url re-select miss
      selectResults: [[], []],
      // first insert conflicts (hash collision), second succeeds
      insertResults: [[], [{ hash: 'Fresh2' }]],
    });
    const out = await new ShortLinker(db).rewrite('https://example.com/x');
    expect(out).toBe(`${BASE}/s/Fresh2`);
    expect(calls.inserts).toBe(2);
  });

  it('uses the racing writer’s hash when a concurrent send inserted the same URL', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    const { db } = stubDb({
      selectResults: [[], [{ hash: 'Raced1' }]], // miss, then post-conflict re-select hits
      insertResults: [[]], // insert conflicted on url
    });
    const out = await new ShortLinker(db).rewrite('https://example.com/x');
    expect(out).toBe(`${BASE}/s/Raced1`);
  });

  it('rewrites a URL with embedded URLs to a SINGLE short link with one mint', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    const { db, calls } = stubDb({});
    const auth =
      'https://accounts.google.com/o/oauth2/auth?scope=https://www.googleapis.com/auth/drive%20' +
      'https://www.googleapis.com/auth/calendar&redirect_uri=http://localhost:35985&response_type=code';
    const out = await new ShortLinker(db).rewrite(`Tap to sign in: ${auth}`);
    // Exactly one short link, nothing left of the original (no partially-rewritten tail).
    expect(out.match(/https:\/\/snny\.ai\/s\/\w+/g)).toHaveLength(1);
    expect(out).toMatch(/^Tap to sign in: https:\/\/snny\.ai\/s\/\w+$/);
    expect(calls.inserts).toBe(1);
  });

  it('falls back to the original URL when the store fails (send must not break)', async () => {
    process.env.SHORT_LINK_BASE_URL = BASE;
    const { db } = stubDb({ selectThrows: true });
    const text = 'see https://example.com/x ok';
    expect(await new ShortLinker(db).rewrite(text)).toBe(text);
  });
});
