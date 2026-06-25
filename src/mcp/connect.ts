import {
  createMCPClient,
  UnauthorizedError,
  type MCPClient,
  type MCPClientConfig,
} from '@ai-sdk/mcp';

/** The object-form transport config (`{ type, url, headers?, authProvider?, redirect? }`).
 *  `@ai-sdk/mcp` doesn't export the type by name, so derive it from `MCPClientConfig`. */
type MCPTransportConfig = Extract<MCPClientConfig['transport'], { type: string }>;
import { resolveByName, type CredentialResolver } from '../credentials/index.js';
import type { McpServerEntry } from './registry.js';
import { SunnyOAuthProvider, type OAuthConsentDriver } from './oauth.js';

/**
 * Remote MCP connection layer (mcp D-MCP3/4/5). Wraps the `@ai-sdk/mcp` client
 * primitive — no hand-rolled protocol. Streamable HTTP (`type: 'http'`) is the
 * default; SSE is a per-server legacy fallback. Two hardening invariants:
 *
 *  - **`redirect: 'error'`** so the transport refuses HTTP redirects (SSRF hardening)
 *    against servers Sunny doesn't control.
 *  - **Auth resolved here, never in model context (D-MCP5).** Header/bearer auth
 *    resolves a credential by NAME through the registry (`resolveByName` → `op://` →
 *    value) into `transport.headers` at connect time; the value never enters the model
 *    context. OAuth is delegated to {@link SunnyOAuthProvider}.
 */

export interface ConnectDeps {
  resolver?: CredentialResolver;
  runtimeDir: string;
  /** Consent handoff for OAuth servers (surface URL to owner / drive `browse`). */
  consent?: OAuthConsentDriver;
}

/** Raised when an OAuth server needs interactive consent before it can connect. The
 *  `authorizationUrl` is the consent link to surface to the owner (D-MCP5). */
export class McpAuthorizationRequired extends Error {
  constructor(
    readonly serverName: string,
    readonly authorizationUrl: URL | null,
  ) {
    super(
      authorizationUrl
        ? `MCP server "${serverName}" needs OAuth consent: ${authorizationUrl.toString()}`
        : `MCP server "${serverName}" needs OAuth authorization`,
    );
    this.name = 'McpAuthorizationRequired';
  }
}

/** Build the transport config for a server, resolving header auth by name (D-MCP4)
 *  and attaching the OAuth provider for `oauth` servers (D-MCP5). The resolved bearer
 *  value lives only in this object's `headers`, never in anything returned to the model. */
export async function buildTransport(
  name: string,
  entry: McpServerEntry,
  deps: ConnectDeps,
): Promise<MCPTransportConfig> {
  const transport: MCPTransportConfig = {
    type: entry.transport,
    url: entry.url,
    // SSRF hardening (D-MCP3): never follow a redirect from a server we don't control.
    redirect: 'error',
  };

  if (entry.auth?.kind === 'header') {
    if (!deps.resolver) {
      throw new Error(
        `MCP server "${name}" needs the credential "${entry.auth.credential}", but no ` +
          `1Password token is configured to resolve it.`,
      );
    }
    const value = await resolveByName(deps.resolver, deps.runtimeDir, entry.auth.credential);
    const header = entry.auth.header ?? 'Authorization';
    const scheme = entry.auth.scheme ?? 'Bearer';
    transport.headers = { [header]: scheme ? `${scheme} ${value}` : value };
  } else if (entry.auth?.kind === 'oauth') {
    transport.authProvider = new SunnyOAuthProvider({
      runtimeDir: deps.runtimeDir,
      serverName: name,
      serverUrl: entry.url,
      consent: deps.consent,
    });
  }

  return transport;
}

/**
 * Open a client to a registered server. The caller MUST `close()` it (connect-per-turn,
 * D-MCP6). Throws {@link McpAuthorizationRequired} when an OAuth server needs consent,
 * so the caller can surface the consent link rather than fail opaquely.
 */
export async function connectMcp(
  name: string,
  entry: McpServerEntry,
  deps: ConnectDeps,
): Promise<MCPClient> {
  const transport = await buildTransport(name, entry, deps);
  const provider =
    transport !== undefined && 'authProvider' in transport
      ? (transport.authProvider as SunnyOAuthProvider | undefined)
      : undefined;
  try {
    return await createMCPClient({ transport, clientName: `sunny:${name}` });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      throw new McpAuthorizationRequired(name, provider?.pendingAuthorizationUrl ?? null);
    }
    throw err;
  }
}

/**
 * Detect how a server wants to authenticate, deterministically, from the protocol —
 * so Sunny never has to guess "token or OAuth?" (the dummy-proofing seam). Per the MCP
 * auth spec (RFC 9728), an OAuth server answers an unauthenticated request with `401` +
 * `WWW-Authenticate: Bearer … resource_metadata="…"`, and that metadata lists the
 * authorization server(s). A static-token server just `401`s with no such pointer. A
 * server needing no auth returns a normal response. We classify on exactly that signal.
 */
export type McpAuthDetection =
  | { scheme: 'none' }
  | { scheme: 'oauth'; authorizationServers: string[]; resourceMetadata?: string }
  | { scheme: 'token'; detail?: string }
  | { scheme: 'unknown'; status?: number; detail?: string };

const WELL_KNOWN_PRM = '/.well-known/oauth-protected-resource';

export async function detectMcpAuth(url: string, timeoutMs = 10_000): Promise<McpAuthDetection> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      signal: ctrl.signal,
    });

    if (res.status !== 401 && res.status !== 403) {
      // Reachable without auth (any non-auth status — including a JSON-RPC error — means
      // the auth gate let us through).
      return { scheme: 'none' };
    }

    // RFC 9728: the 401 points at protected-resource metadata. Prefer the header's URL;
    // fall back to the conventional well-known path under the server origin.
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    const fromHeader = /resource_metadata="?([^",\s]+)"?/i.exec(wwwAuth)?.[1];
    const candidates = [fromHeader, prmPathFor(url), originOf(url) + WELL_KNOWN_PRM].filter(
      (v): v is string => Boolean(v),
    );

    for (const metaUrl of candidates) {
      const servers = await fetchAuthorizationServers(metaUrl, ctrl.signal);
      if (servers) {
        return { scheme: 'oauth', authorizationServers: servers, resourceMetadata: metaUrl };
      }
    }

    // 401 with no OAuth discovery → a static bearer/header token the owner supplies.
    return { scheme: 'token', detail: wwwAuth || `HTTP ${res.status}` };
  } catch (err) {
    return { scheme: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Build the path-scoped protected-resource metadata URL (origin + well-known + path),
 *  which path-routed MCP servers (e.g. craft's per-link endpoints) use. */
function prmPathFor(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${WELL_KNOWN_PRM}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

async function fetchAuthorizationServers(
  metaUrl: string,
  signal: AbortSignal,
): Promise<string[] | null> {
  try {
    const r = await fetch(metaUrl, {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal,
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { authorization_servers?: unknown };
    const servers = Array.isArray(body.authorization_servers)
      ? body.authorization_servers.filter((s): s is string => typeof s === 'string')
      : [];
    return servers.length > 0 ? servers : null;
  } catch {
    return null;
  }
}

/** A tool inventory entry: name + description, no invocation (D-MCP4). */
export interface McpToolInfo {
  name: string;
  description: string;
}

/** Connect, enumerate the server's tools (names + descriptions, NO calls), and close.
 *  This is the `probe` primitive (D-MCP4): it reports what the server exposes without
 *  invoking anything. */
export async function probeMcp(
  name: string,
  entry: McpServerEntry,
  deps: ConnectDeps,
): Promise<{ tools: McpToolInfo[]; serverInfo: { name: string; version: string } | null }> {
  const client = await connectMcp(name, entry, deps);
  try {
    const listed = await client.listTools();
    const tools: McpToolInfo[] = listed.tools.map((t) => ({
      name: t.name,
      description: (t.description ?? '').slice(0, 500),
    }));
    const serverInfo = client.serverInfo
      ? { name: client.serverInfo.name, version: client.serverInfo.version }
      : null;
    return { tools, serverInfo };
  } finally {
    await client.close().catch(() => undefined);
  }
}
