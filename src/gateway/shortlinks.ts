import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { shortLinks } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger('gateway:shortlinks');

/**
 * Base58-style alphabet (no 0OIl) — short links occasionally get read aloud or
 * retyped, so drop the lookalike glyphs. 54^6 ≈ 2.5e10 — collision retry is enough.
 */
const HASH_ALPHABET = '123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
export const HASH_LENGTH = 6;

/** Valid `/s/<hash>` path segment — the route rejects anything else without a DB hit. */
export const HASH_PATTERN = new RegExp(`^[${HASH_ALPHABET}]{${HASH_LENGTH}}$`);

/**
 * The public short-link origin (`https://snny.ai`). Unset ⇒ shortening (and callback
 * hosting) disabled — dev/test-safe, mirroring `DASHBOARD_PUBLIC_URL`. Read lazily
 * because `process.loadEnvFile()` runs after module import.
 */
export function shortLinkBaseUrl(): string | undefined {
  const raw = process.env.SHORT_LINK_BASE_URL?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, '');
}

function mintHash(): string {
  let hash = '';
  for (let i = 0; i < HASH_LENGTH; i++) hash += HASH_ALPHABET[randomInt(HASH_ALPHABET.length)];
  return hash;
}

/**
 * Conservative URL extraction: match `https?://` runs of non-whitespace, then peel
 * trailing punctuation that in prose belongs to the sentence, not the URL
 * (`.,;:!?"'`, plus `)`/`]` only when unbalanced within the match — Wikipedia-style
 * `(...)` path segments survive). Better to under-shorten than mangle a message.
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>]+/gi) ?? [];
  const urls: string[] = [];
  for (let url of matches) {
    for (;;) {
      const last = url[url.length - 1];
      if (!last) break;
      if ('.,;:!?"\''.includes(last)) {
        url = url.slice(0, -1);
      } else if (
        (last === ')' && countChar(url, '(') < countChar(url, ')')) ||
        (last === ']' && countChar(url, '[') < countChar(url, ']'))
      ) {
        url = url.slice(0, -1);
      } else {
        break;
      }
    }
    // A bare scheme+host needs at least one host char to be a URL at all.
    if (/^https?:\/\/[^\s/]+/i.test(url)) urls.push(url);
  }
  return urls;
}

function countChar(s: string, c: string): number {
  let n = 0;
  for (const ch of s) if (ch === c) n++;
  return n;
}

/**
 * Outbound URL shortening (short-links spec). One instance per runtime, shared by
 * the transport drivers, which call {@link rewrite} as the LAST text transformation
 * before the wire send — persisted history upstream keeps the original long URLs.
 */
export class ShortLinker {
  constructor(private readonly db: Db) {}

  /**
   * Replace every http(s) URL in `text` with `<base>/s/<hash>`. No-op when
   * `SHORT_LINK_BASE_URL` is unset. NEVER throws and never blocks a send: any
   * store failure falls back to the original URL for that link.
   */
  async rewrite(text: string): Promise<string> {
    const base = shortLinkBaseUrl();
    if (!base || !text) return text;
    const urls = [...new Set(extractUrls(text))];
    let out = text;
    for (const url of urls) {
      if (url.toLowerCase().startsWith(base.toLowerCase() + '/')) continue; // already ours
      try {
        const hash = await this.hashFor(url);
        out = out.split(url).join(`${base}/s/${hash}`);
      } catch (err) {
        // Deliver the long URL rather than fail or delay the send.
        log.warn('short-link mint failed; sending original URL', { err: String(err) });
      }
    }
    return out;
  }

  /** Dedupe-or-mint: the same long URL always yields the same hash. */
  private async hashFor(url: string): Promise<string> {
    const existing = await this.db
      .select({ hash: shortLinks.hash })
      .from(shortLinks)
      .where(eq(shortLinks.url, url))
      .limit(1);
    if (existing[0]) return existing[0].hash;
    // Mint with collision retry. An insert can conflict on EITHER unique key:
    // `url` (a concurrent send of the same URL won the race — reuse its row) or
    // `hash` (random collision — retry with a fresh hash).
    for (let attempt = 0; attempt < 5; attempt++) {
      const hash = mintHash();
      const inserted = await this.db
        .insert(shortLinks)
        .values({ hash, url })
        .onConflictDoNothing()
        .returning({ hash: shortLinks.hash });
      if (inserted[0]) return inserted[0].hash;
      const raced = await this.db
        .select({ hash: shortLinks.hash })
        .from(shortLinks)
        .where(eq(shortLinks.url, url))
        .limit(1);
      if (raced[0]) return raced[0].hash;
      // else: hash collision — loop mints a new one
    }
    throw new Error('could not mint a unique short-link hash after 5 attempts');
  }

  /** Resolve a hash for the `/s/[hash]` route. Null when unknown/malformed. */
  async resolve(hash: string): Promise<string | null> {
    if (!HASH_PATTERN.test(hash)) return null;
    const rows = await this.db
      .select({ url: shortLinks.url })
      .from(shortLinks)
      .where(eq(shortLinks.hash, hash))
      .limit(1);
    return rows[0]?.url ?? null;
  }
}
