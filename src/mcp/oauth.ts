import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from '@ai-sdk/mcp';
import { logger } from '../logger.js';
import { normalizeMcpName } from './registry.js';

const log = logger('mcp:oauth');

/**
 * OAuth 2.1 client provider for MCP servers (mcp D-MCP5). Wraps the protocol carried
 * by `@ai-sdk/mcp`; this class supplies only the storage + policy seams:
 *
 *  - **Token store beside the registry.** Client info, tokens, the PKCE code verifier,
 *    and the CSRF state live in `~/.sunny/mcp-oauth/<server>.json` (0600), like the
 *    credential registry: reviewable on disk, but NEVER surfaced to the model. The
 *    model only ever handles the server name.
 *  - **Consent through `browse`.** When the SDK needs interactive consent it calls
 *    `redirectToAuthorization(url)`; we hand the URL to the injected consent driver,
 *    which surfaces it to the owner / drives the existing `browse` capability — Sunny
 *    never silently authorizes a third party.
 *  - **Authorization-server origin allowlist.** `validateAuthorizationServerURL` is
 *    called before the SDK fetches OAuth metadata; we reject any authorization server
 *    whose origin isn't the MCP server's own origin (or an explicit allowlist),
 *    hardening against a rogue server pointing us at an attacker's authorization server.
 *
 * Full hardening (token rotation, consent re-review, egress) folds into
 * `security-permissions`; this is the capability seam it builds on.
 */

/** Drives interactive consent (D-MCP5): given the authorization URL, surface it to
 *  the owner and/or open it via the `browse` capability. Returns nothing — the flow
 *  is attended/out-of-band, so the connect attempt reports "authorization required". */
export type OAuthConsentDriver = (
  authorizationUrl: URL,
  serverName: string,
) => void | Promise<void>;

interface OAuthStore {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

export interface SunnyOAuthOptions {
  runtimeDir: string;
  serverName: string;
  /** The MCP server URL — its origin is the default allowed authorization-server origin. */
  serverUrl: string;
  /** OAuth redirect URI Sunny registers (the consent flow returns here, attended). */
  redirectUri?: string;
  /** Extra authorization-server origins to allow beyond the server's own origin. */
  allowedAuthOrigins?: string[];
  /** Consent handoff (surface URL to owner / browse). Optional: absent ⇒ we record
   *  the URL and the connect attempt reports it. */
  consent?: OAuthConsentDriver;
}

/** OAuth callback path served (ungated) by the dashboard route. */
export const MCP_OAUTH_CALLBACK_PATH = '/dashboard/api/mcp/oauth/callback';

/** The public, reachable redirect URI for OAuth consent — NOT localhost (a phone/
 *  browser must reach it). Derived from the dashboard's public URL (D-WD); the
 *  callback route completes the token exchange. No fallback: an unset URL is a
 *  loud error (surfaced in the mcp_manage tool result), never a redirect to a
 *  host this machine doesn't own (portability D12). */
export function defaultRedirectUri(): string {
  const base = process.env.DASHBOARD_PUBLIC_URL?.replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'DASHBOARD_PUBLIC_URL is not set — MCP OAuth needs a publicly reachable redirect URI. ' +
        "Set it to this host's public HTTPS URL and retry.",
    );
  }
  return `${base}${MCP_OAUTH_CALLBACK_PATH}`;
}

export class SunnyOAuthProvider implements OAuthClientProvider {
  private readonly file: string;
  private readonly serverOrigin: string;
  private readonly allowed: Set<string>;
  /** The most recent authorization URL the SDK asked us to open (for reporting). */
  pendingAuthorizationUrl: URL | null = null;

  constructor(private readonly opts: SunnyOAuthOptions) {
    const dir = join(opts.runtimeDir, 'mcp-oauth');
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${normalizeMcpName(opts.serverName)}.json`);
    this.serverOrigin = originOf(opts.serverUrl);
    this.allowed = new Set(
      [this.serverOrigin, ...(opts.allowedAuthOrigins ?? [])].filter(Boolean).map((o) => o),
    );
  }

  // --- storage (never surfaced to the model) --------------------------------

  private read(): OAuthStore {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as OAuthStore;
    } catch (err) {
      log.warn('could not parse oauth store (treating as empty)', {
        server: this.opts.serverName,
        err: String(err),
      });
      return {};
    }
  }

  /** Serialized, atomic read-modify-write of the token store. A fresh provider is
   *  created per connection, so — unlike every other store here — the lock must be
   *  MODULE-level ({@link serializeOAuthWrite}) to serialize concurrent refreshes
   *  writing the same file. Without it, two refreshes could interleave their
   *  read-spread-write and clobber a just-rotated refresh token → `invalid_grant`. */
  private write(patch: Partial<OAuthStore>): Promise<void> {
    return serializeOAuthWrite(() => {
      const next = { ...this.read(), ...patch };
      atomicWriteStore(this.file, `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  get redirectUrl(): string {
    return this.opts.redirectUri ?? defaultRedirectUri();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Sunny',
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.read().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformation): Promise<void> {
    return this.write({ clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.write({ tokens });
  }

  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.write({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error('no PKCE code verifier stored (authorization not started)');
    return v;
  }

  saveState(state: string): Promise<void> {
    return this.write({ state });
  }

  /** Mint a FRESH CSRF state for a new authorization request and persist it so the
   *  callback can validate it (`storedState`). This is generate-and-save, NOT a read
   *  of prior state — reading the stored value is `storedState()`. (The earlier
   *  read-and-throw here was the "no OAuth state stored" connect failure.) */
  async state(): Promise<string> {
    const s = randomBytes(16).toString('base64url');
    await this.write({ state: s });
    return s;
  }

  storedState(): string | undefined {
    return this.read().state;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    return serializeOAuthWrite(() => {
      if (scope === 'all') {
        atomicWriteStore(this.file, '{}\n');
        return;
      }
      const store = this.read();
      if (scope === 'client') delete store.clientInformation;
      if (scope === 'tokens') delete store.tokens;
      if (scope === 'verifier') delete store.codeVerifier;
      atomicWriteStore(this.file, `${JSON.stringify(store, null, 2)}\n`);
    });
  }

  // --- policy seams ---------------------------------------------------------

  /** Drive interactive consent (D-MCP5): record + hand off the authorization URL.
   *  Consent is attended/out-of-band, so we never auto-follow it here. */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.pendingAuthorizationUrl = authorizationUrl;
    log.info('oauth consent required', {
      server: this.opts.serverName,
      authorizationHost: authorizationUrl.host,
    });
    if (this.opts.consent) await this.opts.consent(authorizationUrl, this.opts.serverName);
  }

  /** Allowlist authorization-server origins before the SDK fetches OAuth metadata
   *  (D-MCP5). Defaults to the MCP server's own origin; reject anything else unless
   *  the owner allowlisted it — a rogue server can't redirect us to an attacker's AS. */
  validateAuthorizationServerURL(
    _serverUrl: string | URL,
    authorizationServerUrl: string | URL,
  ): void {
    const origin = originOf(authorizationServerUrl);
    if (!this.allowed.has(origin)) {
      throw new Error(
        `authorization-server origin ${origin} is not allowlisted for MCP server ` +
          `"${this.opts.serverName}" (allowed: ${[...this.allowed].join(', ') || 'none'})`,
      );
    }
  }
}

function originOf(url: string | URL): string {
  try {
    return new URL(url).origin;
  } catch {
    return String(url);
  }
}

// Serialized OAuth-store writes (mirrors the credential/registry/memory stores'
// R7 write chains). MODULE-level on purpose: a fresh provider is created per
// connection, so an instance lock wouldn't serialize two concurrent refreshes of
// the same server. The read-modify-write runs inside the critical section so a
// second refresh always sees the first's rotated tokens instead of clobbering them.
let oauthWriteChain: Promise<unknown> = Promise.resolve();
function serializeOAuthWrite(fn: () => void): Promise<void> {
  const next = oauthWriteChain.then(fn, fn);
  oauthWriteChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Atomic store write: temp file + rename, so a crash or concurrent reader never
 *  sees a torn/half-written JSON (which `read()` would swallow as empty and then
 *  clobber on the next write). */
function atomicWriteStore(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

// --- store helpers (used by the loop guard + the OAuth callback route) ------

function oauthDir(runtimeDir: string): string {
  return join(runtimeDir, 'mcp-oauth');
}

function oauthStorePath(runtimeDir: string, serverName: string): string {
  return join(oauthDir(runtimeDir), `${normalizeMcpName(serverName)}.json`);
}

function readStore(runtimeDir: string, serverName: string): OAuthStore {
  const file = oauthStorePath(runtimeDir, serverName);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as OAuthStore;
  } catch {
    return {};
  }
}

/** Whether a usable access token is already stored for a server (the loop only
 *  auto-connects OAuth servers that are ALREADY authorized — it never kicks off
 *  interactive consent mid-conversation; that happens via `mcp_manage`). */
export function oauthTokensPresent(runtimeDir: string, serverName: string): boolean {
  return Boolean(readStore(runtimeDir, serverName).tokens?.access_token);
}

/** Find which registered OAuth server an in-flight authorization `state` belongs to,
 *  so the callback route can complete the right server's token exchange. */
export function findOAuthServerByState(runtimeDir: string, state: string): string | null {
  const dir = oauthDir(runtimeDir);
  if (!state || !existsSync(dir)) return null;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const name = file.replace(/\.json$/, '');
    if (readStore(runtimeDir, name).state === state) return name;
  }
  return null;
}
