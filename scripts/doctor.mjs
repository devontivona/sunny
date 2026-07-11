#!/usr/bin/env node
/**
 * `npm run doctor` — fresh-machine preflight (first-run-setup spec). One line per
 * check, pass/fail + a remediation hint; exits non-zero if any REQUIRED check
 * fails. Deliberately imports nothing from src/ (it must run usefully on a
 * half-configured machine): plain Node + the `pg` client that's already a dep.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const runtimeDir = process.env.SUNNY_HOME ?? join(homedir(), '.sunny');
let failures = 0;
const results = [];
function check(name, required, ok, hint) {
  if (!ok && required) failures += 1;
  results.push(`${ok ? ' ok ' : required ? 'FAIL' : 'warn'}  ${name}${ok ? '' : ` — ${hint}`}`);
}

// --- required env ------------------------------------------------------------
const envHint = (v, why) => `set ${v} in .env (${why})`;
check('env: ANTHROPIC_API_KEY', true, !!process.env.ANTHROPIC_API_KEY, envHint('ANTHROPIC_API_KEY', 'the agent cannot call the model'));
check('env: DATABASE_URL', true, !!process.env.DATABASE_URL, envHint('DATABASE_URL', 'Postgres for messages/schedules'));
check('env: WORKFLOW_TARGET_WORLD', true, !!process.env.WORKFLOW_TARGET_WORLD, envHint('WORKFLOW_TARGET_WORLD', 'durable workflows need the postgres world, e.g. @workflow/world-postgres'));
check('env: WORKFLOW_POSTGRES_URL', true, !!(process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL), envHint('WORKFLOW_POSTGRES_URL', 'where WDK durable state lives (DATABASE_URL is used as fallback)'));
const sendblue = ['SENDBLUE_API_KEY', 'SENDBLUE_API_SECRET', 'SENDBLUE_FROM_NUMBER', 'SENDBLUE_WEBHOOK_SECRET'];
check('env: SENDBLUE_* (4 vars)', false, sendblue.every((v) => !!process.env[v]), 'iMessage transport disabled without all four (service still boots in loopback mode)');
check('env: DASHBOARD_PUBLIC_URL', false, !!process.env.DASHBOARD_PUBLIC_URL, "media links, MCP OAuth, and approve links degrade without this host's public URL");

// --- owner identity ----------------------------------------------------------
let ownerOk = false;
try {
  const cfg = JSON.parse(readFileSync(join(runtimeDir, 'config.json'), 'utf8'));
  ownerOk = Array.isArray(cfg.owner?.identities) && cfg.owner.identities.length > 0;
} catch {
  /* missing config counts as not configured */
}
check('config: owner.identities', true, ownerOk, `add your iMessage phone/email to ${join(runtimeDir, 'config.json')} → owner.identities`);

// --- authored surface (agent/) ------------------------------------------------
check('repo: agent/builtin present at cwd', true, existsSync(join(process.cwd(), 'agent', 'builtin')), 'run from the repo root (same contract as drizzle/ migrations)');

// --- host CLIs -----------------------------------------------------------------
for (const bin of ['rg', 'jq', 'fd', 'git', 'gh', 'tmux']) {
  let ok = true;
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
  } catch {
    ok = false;
  }
  check(`cli: ${bin}`, bin === 'git', ok, `install ${bin} (agent bash/coding workflows use it)`);
}

// --- git auth to configured remotes -------------------------------------------
function remoteUrl(repo) {
  return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\.{0,2}\/)/.test(repo) ? repo : `https://github.com/${repo}.git`;
}
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(join(runtimeDir, 'config.json'), 'utf8'));
} catch {
  /* checked above */
}
for (const [label, repo] of [
  ['state repo', cfg.state?.repo],
  ['skills repo', cfg.skills?.repo],
]) {
  if (!repo) {
    check(`git: ${label}`, false, true, '');
    continue;
  }
  let ok = true;
  try {
    execFileSync('git', ['ls-remote', '--exit-code', remoteUrl(repo), 'HEAD'], { stdio: 'ignore', timeout: 15000 });
  } catch {
    ok = false;
  }
  check(`git: ${label} reachable (${repo})`, false, ok, 'check the gh credential helper / ssh key on this host');
}

// --- database ------------------------------------------------------------------
async function dbChecks() {
  if (!process.env.DATABASE_URL) {
    check('db: reachable', true, false, 'DATABASE_URL unset');
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    check('db: reachable', true, false, 'npm ci first (pg not installed)');
    return;
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await pool.query('select 1');
    check('db: reachable', true, true, '');

    const wdk = await pool.query(
      "select count(*)::int as n from information_schema.tables where table_schema = 'workflow'",
    );
    check('db: WDK world tables', true, wdk.rows[0].n > 0, 'start the service once (auto-provisions) or run `npm run db:setup-world`');

    const journal = JSON.parse(readFileSync(join(process.cwd(), 'drizzle', 'meta', '_journal.json'), 'utf8'));
    const latest = journal.entries.at(-1)?.tag;
    let applied = 0;
    try {
      const r = await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations');
      applied = r.rows[0].n;
    } catch {
      /* schema absent = nothing applied yet */
    }
    check(
      `db: migrations current (${applied}/${journal.entries.length}, latest ${latest})`,
      false,
      applied >= journal.entries.length,
      'migrations auto-apply on boot; start the service once',
    );
  } catch (err) {
    check('db: reachable', true, false, `cannot connect: ${String(err).split('\n')[0]}`);
  } finally {
    await pool.end().catch(() => {});
  }
}
await dbChecks();

// --- report --------------------------------------------------------------------
console.log(results.join('\n'));
console.log(
  '\nreminder (not auto-verifiable): Sendblue inbound needs this host exposed at a public ' +
    'HTTPS URL with the Sendblue dashboard "Receive" webhook pointed at ' +
    '<public-url>/webhooks/sendblue. Default owner timezone is America/New_York — change ' +
    `it in ${join(runtimeDir, 'config.json')} if that's not you.`,
);
if (failures > 0) {
  console.error(`\n${failures} required check(s) failed.`);
  process.exit(1);
}
console.log('\nall required checks passed.');
