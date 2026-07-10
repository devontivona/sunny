import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { SunnyConfig } from '../config/index.js';
import { indexHasTopicLine, memoryPaths } from '../memory/index.js';

/**
 * The `sunny memory` subcommands (context-lifecycle): deterministic checks over the
 * files-first memory tree. First command: `memory lint` — the INDEX↔topics consistency
 * report. Nothing here is dream-specific (no watermark, no DB); the dreaming job is just
 * the first consumer (`dream digest` embeds the same report and skill:dreaming runs the
 * standalone command as its verify-after-fix loop).
 */

export interface IndexLint {
  /** Topic docs on disk with no INDEX routing line (pre-invariant legacy). */
  missingFromIndex: string[];
  /** INDEX bullet slugs whose topic doc no longer exists. */
  staleIndexLines: string[];
  /** INDEX lines still carrying the auto-added "(stub …)" marker — need a real description. */
  stubLines: string[];
}

/**
 * The INDEX↔topics consistency check (detection ONLY — deterministic, repo-owned). Fixes
 * are deliberately NOT automated: adding/upgrading a line needs judgement (a real
 * description of what the doc holds), and every INDEX mutation must go through
 * `memory_write` (the serialized writer + cap enforcement + git commit), never a CLI
 * editing the file.
 */
export function lintIndex(indexBody: string, topicSlugs: string[]): IndexLint {
  const missingFromIndex = topicSlugs.filter((slug) => !indexHasTopicLine(indexBody, slug));
  const topicSet = new Set(topicSlugs);
  const staleIndexLines: string[] = [];
  const stubLines: string[] = [];
  for (const line of indexBody.split('\n')) {
    const m = /^\s*-\s*([a-z0-9][a-z0-9-]*)\s*:/.exec(line);
    if (!m) continue;
    if (!topicSet.has(m[1]!)) staleIndexLines.push(m[1]!);
    else if (line.includes('(stub')) stubLines.push(m[1]!);
  }
  return { missingFromIndex, staleIndexLines, stubLines };
}

/** The lint report, one actionable line per finding — shared verbatim by the digest's
 *  INDEX LINT section and the standalone `memory lint` command. */
export function renderLintReport(lint: IndexLint): string {
  const lines: string[] = [];
  for (const slug of lint.missingFromIndex) {
    lines.push(`topic doc with NO INDEX line (add one): ${slug}`);
  }
  for (const slug of lint.staleIndexLines) {
    lines.push(`INDEX line with NO topic doc (remove or fix): ${slug}`);
  }
  for (const slug of lint.stubLines) {
    lines.push(`stub INDEX line (replace the placeholder with a real description): ${slug}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'INDEX.md and topics/ are consistent — clean.';
}

/** INDEX lint against the live memory tree (topics/ dir + INDEX.md). */
export function lintIndexFromDisk(config: SunnyConfig): IndexLint {
  const paths = memoryPaths(config.runtimeDir);
  const indexBody = existsSync(paths.INDEX) ? readFileSync(paths.INDEX, 'utf8') : '';
  const slugs = existsSync(paths.topicsDir)
    ? readdirSync(paths.topicsDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -'.md'.length))
    : [];
  return lintIndex(indexBody, slugs);
}

/** The `memory lint` command: recompute + render the report from the live memory tree.
 *  Read-only; the dreaming run re-runs it after fixes until it reports clean. */
export function lint(config: SunnyConfig): string {
  return renderLintReport(lintIndexFromDisk(config));
}
