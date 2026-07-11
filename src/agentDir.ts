import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The git-committed authored surface (`agent/` at the repo root — the portability
 * change). Resolved cwd-relative, the same deployment contract as `drizzle/`
 * migrations: dev and the production `.output` build both run with cwd at the
 * repo root. Two mechanisms live under it:
 *   - `agent/builtin/` — developer-owned, authoritative, read in place at runtime
 *     (builtin skills + builtin schedules). Never copied into `~/.sunny`.
 *   - `agent/seeds/`  — write-if-missing templates whose ownership transfers to
 *     the runtime after first materialization (memory starters, default config).
 */
export function agentDir(): string {
  // SUNNY_AGENT_DIR: test seam (unit tests point it at a scratch dir so the real
  // repo builtins don't leak into fixtures) and escape hatch for a deployment
  // whose cwd is not the repo root.
  return process.env.SUNNY_AGENT_DIR ?? join(process.cwd(), 'agent');
}

export function builtinSkillsDir(): string {
  return join(agentDir(), 'builtin', 'skills');
}

export function builtinSchedulesDir(): string {
  return join(agentDir(), 'builtin', 'schedules');
}

export function seedsDir(): string {
  return join(agentDir(), 'seeds');
}

/** Missing `agent/builtin` is a packaging/deployment error (wrong cwd or an
 *  incomplete checkout), never a soft "no builtins" state — fail explicitly. */
export function assertAgentSurface(): void {
  if (!existsSync(join(agentDir(), 'builtin'))) {
    throw new Error(
      `agent/builtin not found at ${agentDir()} — the service must run with cwd at the repo root ` +
        `(same contract as drizzle/ migrations)`,
    );
  }
}

/** Read a file under `agent/seeds/` (absence is a packaging error, not a default). */
export function readSeedFile(...segments: string[]): string {
  const path = join(seedsDir(), ...segments);
  if (!existsSync(path)) {
    throw new Error(`agent/seeds file missing: ${path} — incomplete checkout or wrong cwd`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * Substitute `{{name}}` placeholders in seed templates at materialization time
 * ({{ownerName}}, {{name}}, {{identity}}). Builtin content needs no placeholders:
 * machine-specific paths are addressed via the `$SUNNY_REPO` convention instead
 * (exported in the agent's bash env; expanded by the file tools), so builtin files
 * are read verbatim and stay byte-identical to what is in git.
 */
export function renderTemplate(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}
