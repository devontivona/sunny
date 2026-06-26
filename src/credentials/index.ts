import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createClient, type Client } from '@1password/sdk';
import { stateDir } from '../config/index.js';
import { commitState } from '../state/index.js';
import { logger } from '../logger.js';

const log = logger('credentials');

const INTEGRATION_NAME = 'Sunny';
const INTEGRATION_VERSION = '0.1.0';

/**
 * Credential resolution plumbing (credentials D-CR1/2/3). Secret values are
 * resolved by the 1Password SDK in the tool-execution layer and injected at the
 * point of use; they are NEVER returned to the model, placed in tool arguments /
 * results, or logged. The model only ever handles `op://` references.
 *
 * A `op://` reference (op://vault/item/field, optionally /section/field) is a
 * pointer, not a secret — only the resolved value is sensitive. The authorization
 * boundary is the vault itself (D-CR3): the Service Account is read-only, so Sunny
 * can never expand what it may use; the owner adding an item to the vault is the
 * grant. The name→reference mapping lives in the registry below (D-CR5), not in
 * code or skills. (No per-tool reference whitelist in the MVP — the vault boundary
 * plus action-gating suffice.)
 */

/** A 1Password secret reference: op://vault/item/field (3+ segments). */
const OP_REFERENCE_RE = /^op:\/\/[^/\s]+(?:\/[^/\s]+){2,}$/;

export function isOpReference(ref: string): boolean {
  return OP_REFERENCE_RE.test(ref.trim());
}

/**
 * Build a resolvable secret reference from IDs. 1Password references require each
 * segment to be alphanumeric (`_`, `.`, `-` allowed) — so a reference built from
 * display titles fails whenever a vault/item/field name has a space or symbol
 * (e.g. "Katie & Devon" / "Gmail (Sunny)"). Vault/item UUIDs and field ids are
 * alphanumeric, so an id-based reference always resolves regardless of the names.
 */
export function buildReference(vaultId: string, itemId: string, fieldId: string): string {
  return `op://${vaultId}/${itemId}/${fieldId}`;
}

/** A field discovered in the vault: its title + the constructed `op://` reference. */
export interface DiscoveredField {
  field: string;
  reference: string;
}

/** An item discovered in an accessible vault. Titles + references only — no values. */
export interface DiscoveredItem {
  vault: string;
  item: string;
  fields: DiscoveredField[];
}

/** Resolves `op://` references to values in the tool layer (D-CR2). Production
 *  uses {@link OnePasswordResolver}; tests inject a fake. */
export interface CredentialResolver {
  resolve(reference: string): Promise<string>;
  /**
   * Discover `op://` references by listing the accessible vault(s) — so Sunny can
   * find a reference itself instead of the owner copying it from the 1Password app
   * (mobile has no "Copy Secret Reference"). Returns item/field TITLES and the
   * constructed references only; field values are NEVER included. Optional.
   */
  listItems?(): Promise<DiscoveredItem[]>;
}

/** Real resolver backed by a 1Password Service Account (D-CR1). The client is
 *  created lazily on first use, so the app starts without a token; credentialed
 *  tools simply fail closed until one is configured. */
export class OnePasswordResolver implements CredentialResolver {
  private clientPromise: Promise<Client> | null = null;

  constructor(private readonly token: string) {}

  private client(): Promise<Client> {
    this.clientPromise ??= createClient({
      auth: this.token,
      integrationName: INTEGRATION_NAME,
      integrationVersion: INTEGRATION_VERSION,
    });
    return this.clientPromise;
  }

  async resolve(reference: string): Promise<string> {
    const ref = reference.trim();
    if (!isOpReference(ref)) {
      throw new Error(`not a valid op:// reference: ${ref}`);
    }
    const client = await this.client();
    return client.secrets.resolve(ref);
  }

  /** List items + field references across the accessible vault(s). Reads each item
   *  to learn its field titles, but exposes only titles + constructed references —
   *  never the resolved values. */
  async listItems(): Promise<DiscoveredItem[]> {
    const client = await this.client();
    const vaults = await client.vaults.list();
    const result: DiscoveredItem[] = [];
    for (const vault of vaults) {
      const overviews = await client.items.list(vault.id);
      for (const overview of overviews) {
        const item = await client.items.get(vault.id, overview.id);
        // Reference uses IDs (always resolvable); titles are shown only for the
        // human/Sunny to identify which credential it is.
        const fields = item.fields
          .filter((f) => f.title.trim().length > 0)
          .map((f) => ({
            field: f.title,
            reference: buildReference(vault.id, item.id, f.id),
          }));
        result.push({ vault: vault.title, item: item.title, fields });
      }
    }
    return result;
  }
}

/**
 * Build the resolver from the environment (D-CR4: the token lives in a hardened
 * `EnvironmentFile`; hardening/rotation itself is in security-permissions).
 * Returns null when no token is set — credentialed tools are then unavailable.
 */
export function resolverFromEnv(): CredentialResolver | null {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim();
  if (!token) {
    log.warn('OP_SERVICE_ACCOUNT_TOKEN not set — credentialed tools/skills will be unavailable');
    return null;
  }
  log.info('1Password credential resolver ready');
  return new OnePasswordResolver(token);
}

// --- credential registry (D-CR5) -------------------------------------------
// The symbolic name → `op://` reference mapping. References + metadata only,
// NEVER values. Lives in `~/.sunny/state/credentials.json`, tracked by the `state`
// git repo (runtime-home) and committed on every write, so it's owner-reviewable,
// editable, and backed up (only `op://` references leave the host, never secret
// values). Tools/skills refer to a credential by name; the value is resolved in the
// tool layer at point of use.

export interface CredentialEntry {
  reference: string;
  purpose?: string;
  addedBy?: string;
}

export type CredentialRegistry = Record<string, CredentialEntry>;

export function credentialsPath(runtimeDir: string): string {
  return join(stateDir(runtimeDir), 'credentials.json');
}

/** Normalize a symbolic credential name to a stable registry key. */
export function normalizeCredentialName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid credential name: ${name}`);
  return slug;
}

export function loadRegistry(runtimeDir: string): CredentialRegistry {
  const file = credentialsPath(runtimeDir);
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as CredentialRegistry) : {};
  } catch (err) {
    log.warn('could not parse credentials registry (treating as empty)', { err: String(err) });
    return {};
  }
}

/** List registered credentials (names + references + purposes — no values). */
export function listCredentials(runtimeDir: string): Array<{ name: string } & CredentialEntry> {
  return Object.entries(loadRegistry(runtimeDir))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({ name, ...entry }));
}

// Serialized registry writes (mirrors memory/skills R7) so concurrent turns/jobs
// cannot corrupt the JSON.
let registryChain: Promise<unknown> = Promise.resolve();
function serializeRegistry<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = registryChain.then(fn, fn);
  registryChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Record a name → reference mapping (D-CR5). Validates the reference shape and
 *  stores no value. The owner provisions the item in the vault; this just records
 *  where it is. */
export function registerCredential(
  runtimeDir: string,
  name: string,
  reference: string,
  meta: { purpose?: string; addedBy?: string } = {},
): Promise<CredentialEntry> {
  return serializeRegistry(async () => {
    const key = normalizeCredentialName(name);
    const ref = reference.trim();
    if (!isOpReference(ref)) throw new Error(`not a valid op:// reference: ${ref}`);
    const registry = loadRegistry(runtimeDir);
    const entry: CredentialEntry = {
      reference: ref,
      ...(meta.purpose ? { purpose: meta.purpose } : {}),
      ...(meta.addedBy ? { addedBy: meta.addedBy } : {}),
    };
    registry[key] = entry;
    const file = credentialsPath(runtimeDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o644 });
    // Commit the registry update to the `state` repo (runtime-home). Best-effort:
    // never fails the registration, even with no repo.
    await commitState(runtimeDir, `credentials: register ${key}`);
    return entry;
  });
}

/** Resolve a credential by its symbolic name: registry → reference → value. The
 *  value is returned to the tool layer only, never to the model (D-CR2). */
export async function resolveByName(
  resolver: CredentialResolver,
  runtimeDir: string,
  name: string,
): Promise<string> {
  const key = normalizeCredentialName(name);
  const entry = loadRegistry(runtimeDir)[key];
  if (!entry) {
    throw new Error(`no credential named "${key}" — ask the owner to add it to the vault`);
  }
  return resolver.resolve(entry.reference);
}
