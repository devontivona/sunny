import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from '../config/index.js';
import { logger } from '../logger.js';
import { sanitizeSlug } from '../slug.js';
import { commitState } from '../state/index.js';

const log = logger('mcp:registry');

/**
 * MCP server registry (mcp D-MCP2) — the sibling of the credential registry
 * (`src/credentials/index.ts`, D-CR5). It records the external MCP tool servers
 * the owner has registered, in `~/.sunny/mcp.json` (inside the `~/.sunny` git repo,
 * owner-reviewable and reversible). Each entry holds **references + metadata only,
 * NEVER secret values**: a symbolic `name`, the server `url`, the `transport`, an
 * optional `auth` REFERENCE (a credential name for header auth, or an OAuth marker),
 * and an `enabled` flag. The owner curating this file (and adding any backing secret
 * to the `Sunny` vault) IS the authorization to use the server — mirroring "the vault
 * is the authorization boundary" (D-CR3).
 *
 * A `last probe` inventory (tool names + descriptions, gathered by `mcp_manage`) is
 * cached here too — metadata, not a value — so the dashboard's MCP directory (D-MCP8)
 * can render the server's tools without reconnecting.
 */

/** Remote transport (D-MCP3). `http` = Streamable HTTP (default); `sse` is a legacy
 *  fallback for a server that requires it. Local stdio is out of scope. */
export type McpTransportKind = 'http' | 'sse';

/** How a server authenticates — a REFERENCE, never a value (D-MCP2/D-MCP5).
 *  `header`: a credential NAME (resolved through the credential registry at connect
 *  time) injected into a request header. `oauth`: an OAuth 2.1 marker; tokens live in
 *  the OAuth token store beside this registry, never here. */
export type McpAuth =
  | {
      kind: 'header';
      /** Credential name in the credential registry (D-CR5) — never the value. */
      credential: string;
      /** Header to set (default `Authorization`). */
      header?: string;
      /** Auth scheme prefix (default `Bearer`; empty string sets the raw value). */
      scheme?: string;
    }
  | { kind: 'oauth' };

/** A cached probe (D-MCP4/8): the tool inventory the server last exposed — names +
 *  descriptions only, no calls, no values. Surfaced read-only in the dashboard. */
export interface McpProbe {
  /** ISO timestamp of the probe. */
  at: string;
  /** The server's self-reported name/version, if any. */
  serverInfo?: { name: string; version: string } | null;
  /** Exposed tools: name + (truncated) description. */
  tools: { name: string; description: string }[];
}

export interface McpServerEntry {
  url: string;
  transport: McpTransportKind;
  auth?: McpAuth;
  enabled: boolean;
  addedBy?: string;
  addedAt?: string;
  /** Free-text note on what the server is for. */
  purpose?: string;
  /** Last probe inventory (cached metadata; see {@link McpProbe}). */
  probe?: McpProbe;
}

export type McpRegistry = Record<string, McpServerEntry>;

/** The registry lives IN the state repo (portability): the server list is learned
 *  knowledge (URLs, names, purposes — never secrets; OAuth tokens stay machine-local
 *  under mcp-oauth/), so it restores on a fresh host with the rest of the state clone. */
export function mcpRegistryPath(runtimeDir: string): string {
  return join(stateDir(runtimeDir), 'mcp.json');
}

/** Pre-portability location (`~/.sunny/mcp.json`, machine-local). Moved into the
 *  state repo on first read; delete once every host has migrated. */
function legacyMcpRegistryPath(runtimeDir: string): string {
  return join(runtimeDir, 'mcp.json');
}

/** One-time migration: relocate a legacy machine-local registry into the state repo. */
function migrateLegacyRegistry(runtimeDir: string): void {
  const legacy = legacyMcpRegistryPath(runtimeDir);
  const current = mcpRegistryPath(runtimeDir);
  if (!existsSync(legacy) || existsSync(current)) return;
  try {
    mkdirSync(dirname(current), { recursive: true });
    renameSync(legacy, current);
    log.info('migrated mcp registry into the state repo', { from: legacy, to: current });
    void commitState(runtimeDir, 'mcp: migrate registry into state repo');
  } catch (err) {
    log.warn('could not migrate legacy mcp registry (non-fatal)', { err: String(err) });
  }
}

/** Normalize a symbolic server name to a stable registry key (shares the one `sanitizeSlug`
 *  canonicalizer with the credential/skill/memory normalizers). */
export function normalizeMcpName(name: string): string {
  return sanitizeSlug(name, 'MCP server name');
}

export function loadMcpRegistry(runtimeDir: string): McpRegistry {
  migrateLegacyRegistry(runtimeDir);
  const file = mcpRegistryPath(runtimeDir);
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as McpRegistry) : {};
  } catch (err) {
    // A corrupt registry must NOT be silently treated as empty: the next mutating
    // write would then persist that empty view and permanently erase every
    // registered server. Quarantine the unparseable file (preserving it for
    // recovery) and refuse to proceed, so no write can clobber it to empty.
    const quarantine = `${file}.corrupt-${Date.now()}`;
    renameSync(file, quarantine);
    log.error('mcp registry unparseable — quarantined, refusing to overwrite', {
      err: String(err),
      quarantine,
    });
    throw new Error(`mcp registry ${file} is corrupt; quarantined to ${quarantine}`);
  }
}

export function getMcpServer(runtimeDir: string, name: string): McpServerEntry | undefined {
  return loadMcpRegistry(runtimeDir)[normalizeMcpName(name)];
}

/** List registered servers (names + metadata + auth references — never values). */
export function listMcpServers(runtimeDir: string): Array<{ name: string } & McpServerEntry> {
  return Object.entries(loadMcpRegistry(runtimeDir))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({ name, ...entry }));
}

/** List only the enabled servers (the set the turn loop merges, D-MCP6). */
export function listEnabledMcpServers(
  runtimeDir: string,
): Array<{ name: string } & McpServerEntry> {
  return listMcpServers(runtimeDir).filter((s) => s.enabled);
}

// Serialized registry writes (mirrors credentials/memory/skills R7) so concurrent
// turns/jobs cannot corrupt the JSON.
let registryChain: Promise<unknown> = Promise.resolve();
function serializeRegistry<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = registryChain.then(fn, fn);
  registryChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function writeRegistry(runtimeDir: string, registry: McpRegistry): void {
  // Atomic write: a temp file + rename so a crash or concurrent reader never sees
  // a torn/half-written registry (which would parse-fail and be quarantined).
  const file = mcpRegistryPath(runtimeDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  // Registry writes are state writes (runtime-home): commit-on-write, push batched.
  void commitState(runtimeDir, 'mcp: update registry');
}

const HTTP_URL_RE = /^https?:\/\/[^/\s]+/i;

export interface RegisterMcpInput {
  url: string;
  transport?: McpTransportKind;
  auth?: McpAuth;
  enabled?: boolean;
  purpose?: string;
  addedBy?: string;
}

/** Record (or update) a server entry (D-MCP2). Validates the URL shape and stores
 *  references + metadata only — never a secret value. Defaults to DISABLED so the
 *  owner can probe/test before enabling (D-MCP4). */
export function registerMcpServer(
  runtimeDir: string,
  name: string,
  input: RegisterMcpInput,
): Promise<{ name: string } & McpServerEntry> {
  return serializeRegistry(() => {
    const key = normalizeMcpName(name);
    const url = input.url.trim();
    if (!HTTP_URL_RE.test(url)) {
      throw new Error(`not a valid http(s) MCP server URL: ${url}`);
    }
    const registry = loadMcpRegistry(runtimeDir);
    const existing = registry[key];
    const entry: McpServerEntry = {
      url,
      transport: input.transport ?? existing?.transport ?? 'http',
      ...(input.auth ? { auth: input.auth } : existing?.auth ? { auth: existing.auth } : {}),
      enabled: input.enabled ?? existing?.enabled ?? false,
      ...((input.purpose ?? existing?.purpose)
        ? { purpose: input.purpose ?? existing?.purpose }
        : {}),
      ...((input.addedBy ?? existing?.addedBy)
        ? { addedBy: input.addedBy ?? existing?.addedBy }
        : {}),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      ...(existing?.probe ? { probe: existing.probe } : {}),
    };
    registry[key] = entry;
    writeRegistry(runtimeDir, registry);
    return { name: key, ...entry };
  });
}

/** Enable/disable a server (D-MCP4). Throws if it isn't registered. */
export function setMcpEnabled(runtimeDir: string, name: string, enabled: boolean): Promise<void> {
  return serializeRegistry(() => {
    const key = normalizeMcpName(name);
    const registry = loadMcpRegistry(runtimeDir);
    const entry = registry[key];
    if (!entry) throw new Error(`no MCP server named "${key}"`);
    entry.enabled = enabled;
    writeRegistry(runtimeDir, registry);
  });
}

/** Remove a server entirely (D-MCP4). Returns whether an entry was removed. */
export function removeMcpServer(runtimeDir: string, name: string): Promise<boolean> {
  return serializeRegistry(() => {
    const key = normalizeMcpName(name);
    const registry = loadMcpRegistry(runtimeDir);
    if (!(key in registry)) return false;
    delete registry[key];
    writeRegistry(runtimeDir, registry);
    return true;
  });
}

/** Cache the latest probe inventory on the entry (D-MCP8). No-op if unregistered. */
export function recordMcpProbe(runtimeDir: string, name: string, probe: McpProbe): Promise<void> {
  return serializeRegistry(() => {
    const key = normalizeMcpName(name);
    const registry = loadMcpRegistry(runtimeDir);
    const entry = registry[key];
    if (!entry) return;
    entry.probe = probe;
    writeRegistry(runtimeDir, registry);
  });
}

/** The host of a server URL (no path/query, never the token-bearing full URL) — what
 *  the dashboard shows instead of the URL (D-MCP8). */
export function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
