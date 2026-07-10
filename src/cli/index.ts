import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * The `sunny` CLI (context-lifecycle): the generic, repo-owned self-interaction surface —
 * capabilities that operate on Sunny's own state ship as tested subcommands here,
 * documented by skills and invoked over bash (`cd <repo> && npx tsx src/cli/index.ts …`),
 * instead of minting new native tools. This entry is a THIN parser: subcommand logic
 * lives in importable, integration-tested modules (`dream.ts`); constraint — anything a
 * readonly (bash-less) run needs must stay a native tool.
 *
 * Bootstraps like the runtime: the repo `.env` supplies `DATABASE_URL`, `loadConfig()`
 * supplies the knobs. Failures exit non-zero with a message written for a MODEL to read
 * and act on.
 */

const USAGE = `usage: sunny <command>

commands:
  dream digest                         print everything since the last dream watermark
  dream lint                           print the INDEX<->topics consistency report (detection
                                       only — fix findings via memory_write, re-run until clean)
  dream compact --thread <threadId> --boundary <messageId> (--summary <text> | --summary-file <path>)
                                       write one thread's compaction summary (validated)
  dream advance --thread <threadId> --message <messageId>
                                       advance the global dream watermark to that row
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  // Env bootstrap: the repo root's .env (two levels up from src/cli/), exactly what the
  // runtime reads for DATABASE_URL. Already-set env vars win over the file.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envFile = join(repoRoot, '.env');
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      /* malformed .env — fall through to the explicit check below */
    }
  }
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set (and no repo .env supplied it) — the CLI needs Postgres.');
  }

  const [group, command, ...rest] = process.argv.slice(2);
  if (group !== 'dream' || !command) fail(USAGE);

  const { loadConfig } = await import('../config/index.js');
  const { createDb } = await import('../db/client.js');
  const dream = await import('./dream.js');
  const config = loadConfig();
  const { db, pool } = createDb(process.env.DATABASE_URL);

  try {
    switch (command) {
      case 'digest': {
        process.stdout.write(`${await dream.digest(db, config)}\n`);
        break;
      }
      case 'lint': {
        process.stdout.write(`${dream.lint(config)}\n`);
        break;
      }
      case 'compact': {
        const { values } = parseArgs({
          args: rest,
          options: {
            thread: { type: 'string' },
            boundary: { type: 'string' },
            summary: { type: 'string' },
            'summary-file': { type: 'string' },
          },
        });
        if (!values.thread || !values.boundary) {
          fail(
            'dream compact needs --thread <threadId> and --boundary <messageId> (an [id:…] from the digest).',
          );
        }
        let summary = values.summary ?? '';
        if (values['summary-file']) {
          if (!existsSync(values['summary-file'])) {
            fail(`--summary-file ${values['summary-file']} does not exist.`);
          }
          summary = readFileSync(values['summary-file'], 'utf8');
        }
        if (!summary.trim()) {
          fail('dream compact needs the summary text: --summary <text> or --summary-file <path>.');
        }
        process.stdout.write(
          `${await dream.compact(db, config, {
            threadId: values.thread,
            boundaryMessageId: values.boundary,
            summary,
          })}\n`,
        );
        break;
      }
      case 'advance': {
        const { values } = parseArgs({
          args: rest,
          options: { thread: { type: 'string' }, message: { type: 'string' } },
        });
        if (!values.thread || !values.message) {
          fail(
            'dream advance needs --thread <threadId> and --message <messageId> (use the exact command the digest printed).',
          );
        }
        process.stdout.write(
          `${await dream.advance(db, { threadId: values.thread, messageId: values.message })}\n`,
        );
        break;
      }
      default:
        fail(USAGE);
    }
  } catch (err) {
    if (err instanceof dream.CliError) fail(err.message);
    throw err;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  fail(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});
