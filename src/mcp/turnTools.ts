import type { SunnyConfig } from '../config/index.js';
import type { CredentialResolver } from '../credentials/index.js';
import { logger } from '../logger.js';
import { connectMcp, type ConnectDeps } from './connect.js';
import { oauthTokensPresent } from './oauth.js';
import { listEnabledMcpServers } from './registry.js';

const log = logger('mcp:turn');

/**
 * Turn-time MCP tool DISCOVERY (mcp D-MCP6/7) — the durable-turn successor of the
 * in-process loop's `assembleMcpTools` (which returned LIVE `Tool` objects bound to open
 * clients; those cannot cross the WDK workflow boundary). Called from `setupTurn`
 * (a `'use step'`, so the result is journaled and identical on replay): connect each
 * ENABLED server, list its tools, and return PLAIN serializable definitions
 * (name/description/raw JSON Schema). The workflow body builds dynamic tools from these,
 * whose `execute` is a journaled per-call step (`mcpCallStep`) that reconnects on the
 * host — connect-per-call, the durable analog of the old connect-per-turn.
 *
 * Only the interactive owner-DM turn discovers MCP tools — background/scheduled/child
 * runs never get them (the attended-only seam, D-MCP7). A server that fails to connect
 * DEGRADES GRACEFULLY: its tools are simply absent for the turn, the failure is logged,
 * and the owner is notified ONCE (deduped below) — it never fails the turn. MCP tool
 * RESULTS are untrusted content (prompt-injection class).
 */

// Notify the owner about a failing server only once (until it recovers), so a
// persistently-down server doesn't spam every turn. Module-level (steps run in the
// host process, so this survives across turns), mirrors skill-sync.
const notifiedFailures = new Set<string>();

/** One MCP tool, as plain data that crosses the WDK step boundary. */
export interface McpToolDef {
  /** Registry server name (the `<server>__<tool>` namespace prefix). */
  server: string;
  name: string;
  description: string;
  /** The tool's input schema as the server advertises it (raw JSON Schema). */
  inputSchema: Record<string, unknown>;
}

export async function discoverMcpToolDefs(
  config: SunnyConfig,
  resolver: CredentialResolver | undefined,
  notifyOwner: (text: string) => void,
): Promise<McpToolDef[]> {
  const enabled = listEnabledMcpServers(config.runtimeDir);
  if (enabled.length === 0) return [];

  const deps: ConnectDeps = { resolver, runtimeDir: config.runtimeDir };
  const defs: McpToolDef[] = [];

  for (const server of enabled) {
    // An enabled OAuth server that isn't authorized yet must NOT trigger interactive
    // consent mid-conversation (that would re-prompt every turn). Skip it until it has
    // tokens — authorization is initiated explicitly via `mcp_manage` (D-MCP5).
    if (server.auth?.kind === 'oauth' && !oauthTokensPresent(config.runtimeDir, server.name)) {
      if (!notifiedFailures.has(server.name)) {
        notifiedFailures.add(server.name);
        notifyOwner(
          `"${server.name}" is enabled but not authorized yet — ask me to connect it and ` +
            `I'll send you the consent link. Its tools are unavailable until then.`,
        );
      }
      continue;
    }
    try {
      const client = await connectMcp(server.name, server, deps);
      try {
        const listed = await client.listTools();
        for (const t of listed.tools) {
          defs.push({
            server: server.name,
            name: t.name,
            description: t.description ?? '',
            inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
          });
        }
      } finally {
        await client.close().catch(() => undefined);
      }
      notifiedFailures.delete(server.name);
    } catch (err) {
      log.warn('mcp server failed to connect; omitting its tools this turn', {
        server: server.name,
        err: String(err),
      });
      if (!notifiedFailures.has(server.name)) {
        notifiedFailures.add(server.name);
        const detail = err instanceof Error ? ` (${err.message})` : '';
        notifyOwner(
          `Heads up — I couldn't reach the MCP server "${server.name}" just now, so its tools ` +
            `are unavailable this turn${detail}.`,
        );
      }
    }
  }

  return defs;
}

/**
 * Invoke one MCP tool by server + name — the body of the turn's per-call `'use step'`
 * (`mcpCallStep`): connect, call, close. Returns the tool's result (serializable MCP
 * content) or an `ERROR …` string — it NEVER throws, so a flaky server degrades to an
 * error the model can read instead of failing (and WDK-retrying) the whole turn.
 */
export async function callMcpTool(
  config: SunnyConfig,
  resolver: CredentialResolver | undefined,
  server: string,
  toolName: string,
  input: unknown,
): Promise<unknown> {
  const { getMcpServer } = await import('./registry.js');
  const entry = getMcpServer(config.runtimeDir, server);
  if (!entry) return `ERROR: MCP server "${server}" is no longer registered.`;
  if (!entry.enabled) return `ERROR: MCP server "${server}" is disabled.`;
  let client;
  try {
    client = await connectMcp(server, entry, { resolver, runtimeDir: config.runtimeDir });
  } catch (err) {
    return `ERROR connecting to MCP server "${server}": ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    return await client.callTool({
      name: toolName,
      arguments: (input ?? {}) as Record<string, unknown>,
    });
  } catch (err) {
    return `ERROR calling "${server}".${toolName}(): ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await client.close().catch(() => undefined);
  }
}
