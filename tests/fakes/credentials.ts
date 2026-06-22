import type { CredentialResolver } from '../../src/credentials/index.js';

/**
 * In-memory credential resolver for tests (no real 1Password). Backed by a
 * reference → value map; records every reference it was asked to resolve so tests
 * can assert the whitelist refused a call before reaching the resolver.
 */
export class FakeResolver implements CredentialResolver {
  readonly seen: string[] = [];

  constructor(private readonly values: Record<string, string> = {}) {}

  resolve(reference: string): Promise<string> {
    this.seen.push(reference);
    const value = this.values[reference];
    if (value === undefined) return Promise.reject(new Error(`fake: no value for ${reference}`));
    return Promise.resolve(value);
  }
}
