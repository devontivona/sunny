import type { CredentialResolver, DiscoveredItem } from '../../src/credentials/index.js';

/**
 * In-memory credential resolver for tests (no real 1Password). Backed by a
 * reference → value map; records every reference it was asked to resolve so tests
 * can assert behavior. Optionally seeded with discoverable items for `listItems`.
 */
export class FakeResolver implements CredentialResolver {
  readonly seen: string[] = [];

  constructor(
    private readonly values: Record<string, string> = {},
    private readonly items: DiscoveredItem[] = [],
  ) {}

  resolve(reference: string): Promise<string> {
    this.seen.push(reference);
    const value = this.values[reference];
    if (value === undefined) return Promise.reject(new Error(`fake: no value for ${reference}`));
    return Promise.resolve(value);
  }

  listItems(): Promise<DiscoveredItem[]> {
    return Promise.resolve(this.items);
  }
}
