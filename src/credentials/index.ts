import { createClient, type Client } from '@1password/sdk';
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
 * pointer, not a secret — only the resolved value is sensitive. The most important
 * guardrail is `scopeResolver` (D-CR3): because 1Password has no per-item scoping
 * and the model can be hijacked, each tool may only resolve the exact references
 * it declares.
 */

/** A 1Password secret reference: op://vault/item/field (3+ segments). */
const OP_REFERENCE_RE = /^op:\/\/[^/\s]+(?:\/[^/\s]+){2,}$/;

export function isOpReference(ref: string): boolean {
  return OP_REFERENCE_RE.test(ref.trim());
}

/** Resolves `op://` references to values in the tool layer (D-CR2). Production
 *  uses {@link OnePasswordResolver}; tests inject a fake. */
export interface CredentialResolver {
  resolve(reference: string): Promise<string>;
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

/**
 * Scope a resolver to an explicit reference whitelist (D-CR3 / tool-access task 6).
 * A scoped resolver refuses any reference not in its declared set, so the model —
 * even if hijacked — cannot cause resolution of an arbitrary `op://` path. This is
 * the per-tool whitelist that substitutes for 1Password's missing per-item scoping
 * and forms the credential half of the tool-registration contract (D-TA0).
 */
export function scopeResolver(
  resolver: CredentialResolver,
  allowed: readonly string[],
): CredentialResolver {
  const whitelist = new Set(allowed.map((r) => r.trim()));
  return {
    async resolve(reference: string): Promise<string> {
      const ref = reference.trim();
      if (!whitelist.has(ref)) {
        throw new Error(`reference not permitted for this tool: ${ref}`);
      }
      return resolver.resolve(ref);
    },
  };
}

/**
 * Resolve a map of `ENV_VAR -> op:// reference` into a plain env object for a
 * subprocess — the `op run`-style per-command injection pattern (D-TA5). Every
 * reference passes through the (typically scoped) resolver, so values reach only
 * that subprocess's environment, never the model.
 */
export async function resolveEnv(
  resolver: CredentialResolver,
  refs: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(refs)) {
    out[key] = await resolver.resolve(ref);
  }
  return out;
}
