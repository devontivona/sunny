import { tool } from 'ai';
import type { SunnyConfig } from '../../config/index.js';
import { listCredentials, type CredentialResolver } from '../../credentials/index.js';
import {
  connectMcp,
  detectMcpAuth,
  probeMcp,
  McpAuthorizationRequired,
  type ConnectDeps,
} from '../../mcp/connect.js';
import type { OAuthConsentDriver } from '../../mcp/oauth.js';
import {
  getMcpServer,
  listMcpServers,
  recordMcpProbe,
  registerMcpServer,
  removeMcpServer,
  serverHost,
  setMcpEnabled,
  type McpAuth,
} from '../../mcp/registry.js';
import { MCP_MANAGE_SPEC, type McpManageInput } from './mcpManageSpecs.js';

export { MCP_MANAGE_SPEC };

/** Optional consent handoff for OAuth servers (surface the consent link to the owner). */
export interface McpManageDeps {
  consent?: OAuthConsentDriver;
}

/** Build the `auth` reference from the tool input (never a value — D-MCP2/5). */
function authFromInput(input: McpManageInput): McpAuth | undefined {
  switch (input.auth_kind) {
    case 'header':
      if (!input.auth_credential) throw new Error('header auth requires auth_credential (a name)');
      return {
        kind: 'header',
        credential: input.auth_credential,
        ...(input.auth_header ? { header: input.auth_header } : {}),
        ...(input.auth_scheme !== undefined ? { scheme: input.auth_scheme } : {}),
      };
    case 'oauth':
      return { kind: 'oauth' };
    default:
      return undefined;
  }
}

function describeAuth(auth: McpAuth | undefined): string {
  if (!auth) return 'no auth';
  return auth.kind === 'header' ? `header auth → credential "${auth.credential}"` : 'OAuth 2.1';
}

/** Run an `mcp_manage` action, returning a result/error string (never throws). */
export async function execMcpManage(
  config: SunnyConfig,
  resolver: CredentialResolver | undefined,
  deps: McpManageDeps,
  input: McpManageInput,
): Promise<string> {
  const connectDeps: ConnectDeps = {
    resolver,
    runtimeDir: config.runtimeDir,
    consent: deps.consent,
  };
  try {
    switch (input.action) {
      case 'list': {
        const servers = listMcpServers(config.runtimeDir);
        if (servers.length === 0) return '(no MCP servers registered yet)';
        return servers
          .map((s) => {
            const probed = s.probe ? `${s.probe.tools.length} tools @ ${s.probe.at}` : 'not probed';
            return (
              `- ${s.name} [${s.enabled ? 'enabled' : 'disabled'}] ${serverHost(s.url)} ` +
              `(${s.transport}, ${describeAuth(s.auth)}; ${probed})`
            );
          })
          .join('\n');
      }

      case 'add': {
        if (!input.name) return 'ERROR: add requires name';
        if (!input.url) return 'ERROR: add requires url';
        let auth: McpAuth | undefined;
        try {
          auth = authFromInput(input);
        } catch (err) {
          return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
        // When the owner didn't specify auth, detect it from the protocol (RFC 9728) so
        // Sunny never guesses token-vs-OAuth: an OAuth server is auto-marked oauth; a
        // token server is flagged so Sunny asks the owner for the secret (request-and-tell).
        let note = '';
        if (!auth) {
          const detected = await detectMcpAuth(input.url);
          if (detected.scheme === 'oauth') {
            auth = { kind: 'oauth' };
            note =
              `\nDetected: this server uses OAuth. Ask me to connect it (I'll send you a ` +
              `consent link to tap) — no token to paste.`;
          } else if (detected.scheme === 'token') {
            note =
              `\nDetected: this server needs a static token. Add it to the Sunny vault, then ` +
              `register it with credential_manage and re-add with header auth ` +
              `(auth_kind="header", auth_credential=<name>).`;
          } else if (detected.scheme === 'none') {
            note = `\nDetected: no auth required — probe and enable it directly.`;
          } else {
            note = `\nCouldn't auto-detect the auth scheme — probe it and see what it returns.`;
          }
        } else if (auth.kind === 'header') {
          // Header auth named explicitly: flag (don't block) a missing backing credential.
          // (Capture the name in a const — `auth` is reassigned above, so TS won't keep
          // the narrowing inside the closure below.)
          const credName = auth.credential;
          const known = listCredentials(config.runtimeDir).some((c) => c.name === credName);
          if (!known) {
            note =
              `\nNote: credential "${credName}" is not registered yet — ask the owner to ` +
              `add it to the Sunny vault, then register it with credential_manage before enabling.`;
          }
        }
        const entry = await registerMcpServer(config.runtimeDir, input.name, {
          url: input.url,
          transport: input.transport,
          auth,
          purpose: input.purpose,
          addedBy: config.owner.name,
        });
        return (
          `Added MCP server "${entry.name}" → ${serverHost(entry.url)} ` +
          `(${entry.transport}, ${describeAuth(entry.auth)}), disabled. ` +
          `Probe it next to see its tools, then enable it.${note}`
        );
      }

      case 'probe': {
        if (!input.name) return 'ERROR: probe requires name';
        const entry = getMcpServer(config.runtimeDir, input.name);
        if (!entry) return `ERROR: no MCP server named "${input.name}" — add it first`;
        try {
          const { tools, serverInfo } = await probeMcp(input.name, entry, connectDeps);
          await recordMcpProbe(config.runtimeDir, input.name, {
            at: new Date().toISOString(),
            serverInfo,
            tools,
          });
          if (tools.length === 0) return `Connected to "${input.name}" — it exposes no tools.`;
          const lines = tools.map((t) => `  - ${t.name}: ${t.description || '(no description)'}`);
          const who = serverInfo ? ` (${serverInfo.name} ${serverInfo.version})` : '';
          return `"${input.name}"${who} exposes ${tools.length} tool(s):\n${lines.join('\n')}`;
        } catch (err) {
          return probeError(input.name, err);
        }
      }

      case 'test': {
        if (!input.name) return 'ERROR: test requires name';
        const entry = getMcpServer(config.runtimeDir, input.name);
        if (!entry) return `ERROR: no MCP server named "${input.name}" — add it first`;
        // No tool named ⇒ fall back to a probe (D-MCP4: "or rely on the probe").
        if (!input.tool) {
          try {
            const { tools } = await probeMcp(input.name, entry, connectDeps);
            return (
              `No tool named to test; "${input.name}" is reachable and exposes ${tools.length} ` +
              `tool(s). Pass "tool" to invoke a specific low-consequence one.`
            );
          } catch (err) {
            return probeError(input.name, err);
          }
        }
        let client;
        try {
          client = await connectMcp(input.name, entry, connectDeps);
        } catch (err) {
          return probeError(input.name, err);
        }
        try {
          const tools = await client.tools();
          const target = tools[input.tool] as unknown as
            | { execute?: (args: unknown, opts: unknown) => unknown }
            | undefined;
          if (!target?.execute) {
            return `ERROR: "${input.name}" has no tool named "${input.tool}" (probe it to see names).`;
          }
          const result = await target.execute(input.tool_args ?? {}, {
            toolCallId: 'mcp-test',
            messages: [],
          });
          const preview = JSON.stringify(result).slice(0, 1500);
          return `Tested "${input.name}".${input.tool}() ✓ — result (untrusted): ${preview}`;
        } catch (err) {
          return `ERROR testing "${input.name}".${input.tool}(): ${errText(err)}`;
        } finally {
          await client.close().catch(() => undefined);
        }
      }

      case 'enable':
      case 'disable': {
        if (!input.name) return `ERROR: ${input.action} requires name`;
        await setMcpEnabled(config.runtimeDir, input.name, input.action === 'enable');
        return input.action === 'enable'
          ? `Enabled "${input.name}" — its tools will load on your owner-DM turns.`
          : `Disabled "${input.name}" — its tools no longer load.`;
      }

      case 'remove': {
        if (!input.name) return 'ERROR: remove requires name';
        const removed = await removeMcpServer(config.runtimeDir, input.name);
        return removed
          ? `Removed MCP server "${input.name}".`
          : `No MCP server named "${input.name}".`;
      }
    }
  } catch (err) {
    return `ERROR: ${errText(err)}`;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shape a connect/probe failure — OAuth consent gets a clear request-and-tell hint. */
function probeError(name: string, err: unknown): string {
  if (err instanceof McpAuthorizationRequired) {
    return err.authorizationUrl
      ? `"${name}" needs OAuth consent. Send the owner this link to authorize, then probe again:\n${err.authorizationUrl}`
      : `"${name}" needs OAuth authorization — ask the owner to complete consent.`;
  }
  return `ERROR connecting to "${name}": ${errText(err)} (check the URL/auth with the owner).`;
}

/**
 * MCP registry tool (mcp D-MCP4). Owner-DM only, sibling to `credential_manage`. The
 * resolver resolves header-auth credentials by name at connect time; the consent
 * driver (optional) surfaces OAuth consent links to the owner.
 */
export function createMcpTools(
  config: SunnyConfig,
  resolver?: CredentialResolver,
  deps: McpManageDeps = {},
) {
  return {
    mcp_manage: tool({
      ...MCP_MANAGE_SPEC,
      execute: (input: McpManageInput) => execMcpManage(config, resolver, deps, input),
    }),
  };
}
