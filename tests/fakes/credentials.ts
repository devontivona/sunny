import type {
  CreatedItem,
  CreateItemParams,
  CredentialResolver,
  DiscoveredItem,
} from '../../src/credentials/index.js';

/**
 * In-memory credential resolver for tests (no real 1Password). Backed by a
 * reference → value map; records every reference it was asked to resolve so tests
 * can assert behavior. Optionally seeded with discoverable items for `listItems`.
 * `createItem` records the created item and makes its reference resolvable, so a
 * save→register→verify chain works end to end.
 */
export class FakeResolver implements CredentialResolver {
  readonly seen: string[] = [];
  readonly created: CreateItemParams[] = [];

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

  createItem(params: CreateItemParams): Promise<CreatedItem> {
    this.created.push(params);
    const ref = `op://fakevault/item${this.created.length}/password`;
    this.values[ref] = params.secretValue;
    return Promise.resolve({
      vault: params.vault ?? 'Sunny',
      item: params.title,
      secretReference: ref,
      fields: [{ field: 'password', reference: ref }],
    });
  }
}
