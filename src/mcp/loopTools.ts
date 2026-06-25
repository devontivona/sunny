import type { Tool } from 'ai';
import type { MCPClient } from '@ai-sdk/mcp';
import type { SunnyConfig } from '../config/index.js';
import type { CredentialResolver } from '../credentials/index.js';
import { logger } from '../logger.js';
import { connectMcp, type ConnectDeps } from './connect.js';
import { oauthTokensPresent } from './oauth.js';
import { listEnabledMcpServers } from './registry.js';

const log = logger('mcp:loop');

/**
 * Turn-loop MCP assembly (mcp D-MCP6/7). At turn assembly, connect each ENABLED
 * server, merge the tools it exposes into the loop tool set, and hand back a `close`
 * the loop calls after the turn (connect-per-turn; pooling deferred). This is the one
 * place Sunny injects non-bash native tools into the loop (the bounded D-TA2 exception),
 * and ONLY the interactive owner-DM turn calls it — background/scheduled runs build
 * their own tool sets and never get MCP tools (the attended-only seam, D-MCP7).
 *
 * A server that fails to connect DEGRADES GRACEFULLY: its tools are simply absent for
 * the turn, the failure is logged, and the owner is notified ONCE (deduped below) — it
 * never fails the turn. MCP tool RESULTS are untrusted content (prompt-injection class);
 * gating of MCP tool calls is the tool-call seam enforced by `security-permissions`.
 */

// Notify the owner about a failing server only once (until it recovers), so a
// persistently-down server doesn't spam every turn. Module-level, mirrors skill-sync.
const notifiedFailures = new Set<string>();

export interface AssembledMcp {
  /** Server tools, namespaced `<server>__<tool>` to avoid clobbering native tools. */
  tools: Record<string, Tool>;
  /** Close every opened client (call after the turn, in a `finally`). */
  close: () => Promise<void>;
}

const EMPTY: AssembledMcp = { tools: {}, close: () => Promise.resolve() };

export async function assembleMcpTools(
  config: SunnyConfig,
  resolver: CredentialResolver | undefined,
  notifyOwner: (text: string) => void,
  consent?: ConnectDeps['consent'],
): Promise<AssembledMcp> {
  const enabled = listEnabledMcpServers(config.runtimeDir);
  if (enabled.length === 0) return EMPTY;

  const deps: ConnectDeps = { resolver, runtimeDir: config.runtimeDir, consent };
  const clients: MCPClient[] = [];
  const tools: Record<string, Tool> = {};

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
      const serverTools = await client.tools();
      clients.push(client);
      for (const [toolName, t] of Object.entries(serverTools)) {
        tools[`${server.name}__${toolName}`] = t as Tool;
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

  return {
    tools,
    close: () =>
      Promise.all(clients.map((c) => c.close().catch(() => undefined))).then(() => undefined),
  };
}
