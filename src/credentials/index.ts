import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Client, ItemCategory, ItemFieldType } from '@1password/sdk';
import { stateDir } from '../config/index.js';
import { commitState } from '../state/index.js';
import { logger } from '../logger.js';
import { sanitizeSlug } from '../slug.js';

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
 * boundary is the vault itself (D-CR3, revised 2026-07-18): the Service Account is
 * write-scoped so Sunny can SAVE credentials it generated itself (new accounts it
 * created for the owner) — but a secret that already lives in the vault still never
 * round-trips through the model; saves are for Sunny-authored values only, and the
 * registry's git history plus the vault's own item history are the audit trail.
 * The name→reference mapping lives in the registry below (D-CR5), not in code or
 * skills. (No per-tool reference whitelist in the MVP — the vault boundary plus
 * action-gating suffice.)
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

/** A new vault item to create (credential save). The secret value passes through
 *  the tool layer once at save time and is never logged or persisted. */
export interface CreateItemParams {
  title: string;
  /** Optional login username (saved as the built-in username field). */
  username?: string;
  /** The secret value (saved as the built-in concealed password field). */
  secretValue: string;
  notes?: string;
  /** Vault TITLE to save into; required only when more than one vault is accessible. */
  vault?: string;
}

/** The created item, described the same way discovery does: titles + constructed
 *  `op://` references only — never values. */
export interface CreatedItem {
  vault: string;
  item: string;
  /** Reference to the concealed secret field (what gets registered). */
  secretReference: string;
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
  /**
   * Save a NEW login item to the vault (D-CR3 revision: write-scoped Service
   * Account). For Sunny-generated credentials only. Optional — requires a
   * write-capable token; fails with the provider's permission error otherwise.
   */
  createItem?(params: CreateItemParams): Promise<CreatedItem>;
}

/** Real resolver backed by a 1Password Service Account (D-CR1). The client is
 *  created lazily on first use, so the app starts without a token; credentialed
 *  tools simply fail closed until one is configured. */
export class OnePasswordResolver implements CredentialResolver {
  private clientPromise: Promise<Client> | null = null;

  constructor(private readonly token: string) {}

  private client(): Promise<Client> {
    // Runtime-resolved import (never bundled): `@1password/sdk-core` loads a sibling
    // `core_bg.wasm` via `__dirname`, which no bundled ESM output has — inlining it
    // crashlooped the 2026-07-05 production build. The specifier is deliberately a
    // VARIABLE: a literal dynamic import still gets chunked by the nitro/rollup pass
    // (verified — @vite-ignore alone did not stop it). The SDK is host-only (a Node
    // app with real node_modules), so resolving it at runtime is always safe here.
    const specifier = '@1password/sdk';
    this.clientPromise ??= (
      import(/* @vite-ignore */ specifier) as Promise<typeof import('@1password/sdk')>
    ).then((sdk) =>
      sdk.createClient({
        auth: this.token,
        integrationName: INTEGRATION_NAME,
        integrationVersion: INTEGRATION_VERSION,
      }),
    );
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

  /** Create a new Login item. Picks the single accessible vault, or the one whose
   *  title matches `params.vault` when several are accessible. */
  async createItem(params: CreateItemParams): Promise<CreatedItem> {
    const client = await this.client();
    const vaults = await client.vaults.list();
    if (vaults.length === 0) throw new Error('no vault accessible to the Service Account');
    let vault = vaults[0]!;
    if (vaults.length > 1) {
      const wanted = params.vault?.trim().toLowerCase();
      const match = wanted && vaults.find((v) => v.title.trim().toLowerCase() === wanted);
      if (!match) {
        throw new Error(
          `several vaults are accessible — pass which one to save into: ${vaults
            .map((v) => v.title)
            .join(', ')}`,
        );
      }
      vault = match;
    }
    // Enum members are plain strings in the SDK ('Login', 'Text', 'Concealed'); string
    // literals + type-only imports keep this module free of a runtime SDK import that
    // the bundler would inline (see client() above for why that crashloops).
    const item = await client.items.create({
      category: 'Login' as ItemCategory,
      vaultId: vault.id,
      title: params.title,
      ...(params.notes ? { notes: params.notes } : {}),
      fields: [
        ...(params.username
          ? [
              {
                id: 'username',
                title: 'username',
                fieldType: 'Text' as ItemFieldType,
                value: params.username,
              },
            ]
          : []),
        {
          id: 'password',
          title: 'password',
          fieldType: 'Concealed' as ItemFieldType,
          value: params.secretValue,
        },
      ],
    });
    const fields = item.fields
      .filter((f) => f.title.trim().length > 0)
      .map((f) => ({ field: f.title, reference: buildReference(vault.id, item.id, f.id) }));
    const secret = item.fields.find((f) => f.id === 'password') ?? item.fields[0];
    if (!secret) throw new Error(`item "${item.title}" was created but came back with no fields`);
    return {
      vault: vault.title,
      item: item.title,
      secretReference: buildReference(vault.id, item.id, secret.id),
      fields,
    };
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

/** Normalize a symbolic credential name to a stable registry key (shares the one `sanitizeSlug`
 *  canonicalizer with the MCP/skill/memory normalizers). */
export function normalizeCredentialName(name: string): string {
  return sanitizeSlug(name, 'credential name');
}

export function loadRegistry(runtimeDir: string): CredentialRegistry {
  const file = credentialsPath(runtimeDir);
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as CredentialRegistry) : {};
  } catch (err) {
    // A corrupt registry must NOT be silently treated as empty: the next
    // registerCredential would then persist that empty view and permanently erase
    // every mapping. Quarantine the unparseable file (preserving it for recovery)
    // and refuse to proceed, so no write can clobber it to empty.
    const quarantine = `${file}.corrupt-${Date.now()}`;
    renameSync(file, quarantine);
    log.error('credentials registry unparseable — quarantined, refusing to overwrite', {
      err: String(err),
      quarantine,
    });
    throw new Error(`credentials registry ${file} is corrupt; quarantined to ${quarantine}`);
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
    await writeRegistry(runtimeDir, registry, `credentials: register ${key}`);
    return entry;
  });
}

/** Atomic registry write (temp file + rename, so a crash or concurrent reader never
 *  sees a torn file) + best-effort `state` repo commit — never fails the operation,
 *  even with no repo. Callers hold the serializeRegistry lock. */
async function writeRegistry(
  runtimeDir: string,
  registry: CredentialRegistry,
  commitMessage: string,
): Promise<void> {
  const file = credentialsPath(runtimeDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  await commitState(runtimeDir, commitMessage, ['credentials.json']);
}

/** Remove a name → reference mapping. Errors on an unknown name — a delete must
 *  never silently no-op (the 2026-07-18 "removing it now" that removed nothing). */
export function deleteCredential(
  runtimeDir: string,
  name: string,
): Promise<{ name: string } & CredentialEntry> {
  return serializeRegistry(async () => {
    const key = normalizeCredentialName(name);
    const registry = loadRegistry(runtimeDir);
    const entry = registry[key];
    if (!entry) throw new Error(`no credential named "${key}" to delete`);
    delete registry[key];
    await writeRegistry(runtimeDir, registry, `credentials: delete ${key}`);
    return { name: key, ...entry };
  });
}

/** Edit an existing mapping in place: rename it and/or repoint its reference and/or
 *  reword its purpose. Errors on an unknown name; a rename refuses to clobber an
 *  existing entry (delete it first if that's really intended). */
export function updateCredential(
  runtimeDir: string,
  name: string,
  changes: { newName?: string; reference?: string; purpose?: string },
): Promise<{ name: string } & CredentialEntry> {
  return serializeRegistry(async () => {
    const key = normalizeCredentialName(name);
    const registry = loadRegistry(runtimeDir);
    const existing = registry[key];
    if (!existing) throw new Error(`no credential named "${key}" to edit`);
    const ref = changes.reference?.trim();
    if (ref && !isOpReference(ref)) throw new Error(`not a valid op:// reference: ${ref}`);
    const nextKey = changes.newName ? normalizeCredentialName(changes.newName) : key;
    if (nextKey !== key && registry[nextKey]) {
      throw new Error(`a credential named "${nextKey}" already exists — delete it first`);
    }
    const entry: CredentialEntry = {
      ...existing,
      ...(ref ? { reference: ref } : {}),
      ...(changes.purpose !== undefined ? { purpose: changes.purpose } : {}),
    };
    delete registry[key];
    registry[nextKey] = entry;
    const label = nextKey === key ? key : `${key} -> ${nextKey}`;
    await writeRegistry(runtimeDir, registry, `credentials: edit ${label}`);
    return { name: nextKey, ...entry };
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
