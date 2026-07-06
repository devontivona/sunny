/**
 * Restrict an arbitrary name to a filesystem- and url-safe slug: lowercase, `[a-z0-9_-]` only,
 * every run of other characters collapsed to a single `-`, and leading/trailing `-` trimmed. The
 * ONE canonicalizer every registry/name normalizer shares (MCP servers, credentials, skills,
 * memory topics + person-id write targets), so their slug rules can't drift apart. Doubles as a
 * path-traversal guard (`../../etc` → `etc`). Throws `invalid ${errorLabel}: ${name}` when nothing
 * survives.
 */
export function sanitizeSlug(name: string, errorLabel: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid ${errorLabel}: ${name}`);
  return slug;
}
