// Type declarations for the plain-JS `skill` helper CLI (bin/skill.mjs), so its
// pure helpers can be imported from TypeScript (the unit tests).

export function sanitizeName(name: unknown): string;
export function parseFrontmatter(raw: string): Record<string, string>;
export function validate(raw: string): { ok: boolean; errors: string[] };
export function composeSkill(input: {
  name: unknown;
  description: unknown;
  body: unknown;
}): string;
export function main(argv: string[]): void;
