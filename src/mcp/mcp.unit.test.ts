import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { makeConfig } from '../../tests/factories.js';
import { FakeResolver } from '../../tests/fakes/credentials.js';
import { execMcpManage } from '../agent/tools/mcpManage.js';
import { registerCredential } from '../credentials/index.js';
import { buildTransport, detectMcpAuth } from './connect.js';
import { SunnyOAuthProvider, findOAuthServerByState, oauthTokensPresent } from './oauth.js';
import {
  getMcpServer,
  listEnabledMcpServers,
  listMcpServers,
  loadMcpRegistry,
  normalizeMcpName,
  registerMcpServer,
  removeMcpServer,
  serverHost,
  setMcpEnabled,
} from './registry.js';

const CRAFT_URL = 'https://mcp.craft.do/links/DSVtQGux9Yz/mcp';

describe('mcp registry (D-MCP2)', () => {
  it('records references + metadata only (no values), disabled by default', async () => {
    const { runtimeDir } = makeConfig();
    expect(listMcpServers(runtimeDir)).toEqual([]);

    await registerMcpServer(runtimeDir, 'Craft', {
      url: CRAFT_URL,
      purpose: 'docs',
      addedBy: 'Devon',
    });

    const reg = loadMcpRegistry(runtimeDir);
    expect(reg.craft).toMatchObject({
      url: CRAFT_URL,
      transport: 'http',
      enabled: false,
      purpose: 'docs',
      addedBy: 'Devon',
    });
    // No auth provided → no auth key; nothing secret stored.
    expect(reg.craft?.auth).toBeUndefined();
  });

  it('stores a header auth REFERENCE (a credential name), never a value', async () => {
    const { runtimeDir } = makeConfig();
    await registerMcpServer(runtimeDir, 'svc', {
      url: 'https://svc.example/mcp',
      auth: { kind: 'header', credential: 'svc-token' },
    });
    const entry = getMcpServer(runtimeDir, 'svc');
    expect(entry?.auth).toEqual({ kind: 'header', credential: 'svc-token' });
    expect(JSON.stringify(loadMcpRegistry(runtimeDir))).not.toContain('secret');
  });

  it('rejects a non-http URL', async () => {
    const { runtimeDir } = makeConfig();
    await expect(registerMcpServer(runtimeDir, 'x', { url: 'ftp://nope' })).rejects.toThrow(
      /valid http/,
    );
  });

  it('enable/disable and remove', async () => {
    const { runtimeDir } = makeConfig();
    await registerMcpServer(runtimeDir, 'craft', { url: CRAFT_URL });
    expect(listEnabledMcpServers(runtimeDir)).toEqual([]);

    await setMcpEnabled(runtimeDir, 'craft', true);
    expect(listEnabledMcpServers(runtimeDir).map((s) => s.name)).toEqual(['craft']);

    expect(await removeMcpServer(runtimeDir, 'craft')).toBe(true);
    expect(listMcpServers(runtimeDir)).toEqual([]);
    expect(await removeMcpServer(runtimeDir, 'craft')).toBe(false);
  });

  it('normalizes names and extracts the host (not the full URL)', () => {
    expect(normalizeMcpName('Craft DO')).toBe('craft-do');
    expect(serverHost(CRAFT_URL)).toBe('mcp.craft.do');
  });
});

describe('mcp connection transport (D-MCP3/4/5)', () => {
  it('sets redirect:error and resolves header auth by name into headers (value never surfaced)', async () => {
    const { runtimeDir } = makeConfig();
    await registerCredential(runtimeDir, 'svc-token', 'op://Sunny/svc/token');
    const resolver = new FakeResolver({ 'op://Sunny/svc/token': 'sek-ret' });

    const transport = await buildTransport(
      'svc',
      {
        url: 'https://svc.example/mcp',
        transport: 'http',
        auth: { kind: 'header', credential: 'svc-token' },
        enabled: true,
      },
      { resolver, runtimeDir },
    );

    expect(transport.type).toBe('http');
    expect(transport.redirect).toBe('error');
    expect(transport.headers).toEqual({ Authorization: 'Bearer sek-ret' });
    expect(resolver.seen).toEqual(['op://Sunny/svc/token']);
  });

  it('attaches an OAuth provider for oauth servers', async () => {
    const { runtimeDir } = makeConfig();
    const transport = await buildTransport(
      'oauthsvc',
      {
        url: 'https://oauth.example/mcp',
        transport: 'http',
        auth: { kind: 'oauth' },
        enabled: true,
      },
      { runtimeDir },
    );
    expect(transport.authProvider).toBeInstanceOf(SunnyOAuthProvider);
  });

  it('errors when header auth has no resolver', async () => {
    const { runtimeDir } = makeConfig();
    await expect(
      buildTransport(
        'svc',
        {
          url: 'https://svc.example/mcp',
          transport: 'http',
          auth: { kind: 'header', credential: 'x' },
          enabled: true,
        },
        { runtimeDir },
      ),
    ).rejects.toThrow(/no 1Password token/);
  });
});

describe('SunnyOAuthProvider origin allowlist (D-MCP5)', () => {
  it('allows the server origin and rejects a foreign authorization-server origin', () => {
    const { runtimeDir } = makeConfig();
    const p = new SunnyOAuthProvider({
      runtimeDir,
      serverName: 'svc',
      serverUrl: 'https://svc.example/mcp',
    });
    expect(() =>
      p.validateAuthorizationServerURL('https://svc.example/mcp', 'https://svc.example'),
    ).not.toThrow();
    expect(() =>
      p.validateAuthorizationServerURL('https://svc.example/mcp', 'https://evil.example'),
    ).toThrow(/not allowlisted/);
  });

  it('state() mints + persists a fresh CSRF state (storedState reads it) — never throws', () => {
    const { runtimeDir } = makeConfig();
    const p = new SunnyOAuthProvider({
      runtimeDir,
      serverName: 'svc',
      serverUrl: 'https://svc.example/mcp',
    });
    expect(p.storedState()).toBeUndefined();
    const s1 = p.state();
    expect(s1).toBeTruthy();
    expect(p.storedState()).toBe(s1); // persisted for callback validation
    expect(p.state()).not.toBe(s1); // a fresh request mints a new one
  });

  it('tracks token presence and finds a server by in-flight state', () => {
    const { runtimeDir } = makeConfig();
    const p = new SunnyOAuthProvider({
      runtimeDir,
      serverName: 'svc',
      serverUrl: 'https://svc.example/mcp',
    });
    expect(oauthTokensPresent(runtimeDir, 'svc')).toBe(false);

    const state = p.state();
    expect(findOAuthServerByState(runtimeDir, state)).toBe('svc');
    expect(findOAuthServerByState(runtimeDir, 'no-such-state')).toBeNull();

    p.saveTokens({ access_token: 'tok', token_type: 'bearer' });
    expect(oauthTokensPresent(runtimeDir, 'svc')).toBe(true);
  });
});

describe('detectMcpAuth — token vs OAuth, from the protocol (RFC 9728)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const resp = (init: { status: number; headers?: Record<string, string>; json?: unknown }) => ({
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(init.json ?? {}),
  });

  it('classifies a reachable (no-auth) server as none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp({ status: 200 })));
    expect(await detectMcpAuth('https://x.example/mcp')).toEqual({ scheme: 'none' });
  });

  it('classifies an OAuth server via the 401 WWW-Authenticate → resource metadata', async () => {
    const metaUrl = 'https://x.example/.well-known/oauth-protected-resource/p';
    const fetchMock = vi.fn(async (u: string) => {
      if (u.endsWith('/mcp')) {
        return resp({
          status: 401,
          headers: {
            'www-authenticate': `Bearer error="invalid_token", resource_metadata="${metaUrl}"`,
          },
        });
      }
      return resp({ status: 200, json: { authorization_servers: ['https://as.example'] } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await detectMcpAuth('https://x.example/mcp');
    expect(out).toEqual({
      scheme: 'oauth',
      authorizationServers: ['https://as.example'],
      resourceMetadata: metaUrl,
    });
  });

  it('classifies a static-token server (401 with no OAuth discovery) as token', async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u.endsWith('/mcp')) {
        return resp({
          status: 401,
          headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
        });
      }
      return resp({ status: 404 }); // no protected-resource metadata anywhere
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await detectMcpAuth('https://x.example/mcp');
    expect(out.scheme).toBe('token');
  });
});

describe('mcp_manage tool (D-MCP4)', () => {
  // `add` without explicit auth runs auth detection (a network fetch). Stub it offline
  // so these stay deterministic; detection itself is covered above.
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve({}),
      }),
    ),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('lists empty, adds (disabled), and lists the server by host + auth-by-name', async () => {
    const config = makeConfig();
    expect(await execMcpManage(config, undefined, {}, { action: 'list' })).toBe(
      '(no MCP servers registered yet)',
    );

    const added = await execMcpManage(
      config,
      undefined,
      {},
      {
        action: 'add',
        name: 'craft',
        url: CRAFT_URL,
      },
    );
    expect(added).toMatch(/Added MCP server "craft"/);
    expect(added).toMatch(/disabled/);

    const list = await execMcpManage(config, undefined, {}, { action: 'list' });
    expect(list).toContain('craft [disabled] mcp.craft.do');
  });

  it('warns when header auth references an unregistered credential (request-and-tell)', async () => {
    const config = makeConfig();
    const out = await execMcpManage(
      config,
      undefined,
      {},
      {
        action: 'add',
        name: 'svc',
        url: 'https://svc.example/mcp',
        auth_kind: 'header',
        auth_credential: 'svc-token',
      },
    );
    expect(out).toMatch(/not registered yet/);
    expect(out).toMatch(/ask the owner/);
  });

  it('enable/disable/remove a server', async () => {
    const config = makeConfig();
    await execMcpManage(config, undefined, {}, { action: 'add', name: 'craft', url: CRAFT_URL });

    expect(await execMcpManage(config, undefined, {}, { action: 'enable', name: 'craft' })).toMatch(
      /Enabled "craft"/,
    );
    expect(getMcpServer(config.runtimeDir, 'craft')?.enabled).toBe(true);

    expect(await execMcpManage(config, undefined, {}, { action: 'remove', name: 'craft' })).toMatch(
      /Removed/,
    );
    expect(getMcpServer(config.runtimeDir, 'craft')).toBeUndefined();
  });

  it('probe errors clearly for an unknown server', async () => {
    const config = makeConfig();
    expect(await execMcpManage(config, undefined, {}, { action: 'probe', name: 'nope' })).toMatch(
      /no MCP server named/,
    );
  });
});
