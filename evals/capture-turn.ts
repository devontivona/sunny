import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { memoryPaths } from '../src/memory/index.js';
import { messages } from '../src/db/schema.js';
import type { FixtureTurn } from './types.js';

/** Trim oversized strings (tool-result outputs, big bash commands) to keep fixtures tidy
 *  — their CONTENT doesn't affect the behavior under test (the send/scratch structure does).
 *  Reasoning `signature` strings are preserved verbatim: trimming them breaks thinking-block
 *  validation when the fixture is replayed. */
function trimLongStrings(v: unknown, key = ''): unknown {
  const MAX = 2000;
  if (typeof v === 'string')
    return key !== 'signature' && v.length > MAX ? `${v.slice(0, MAX)}…[trimmed]` : v;
  if (Array.isArray(v)) return v.map((x) => trimLongStrings(x));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = trimLongStrings(val, k);
    return out;
  }
  return v;
}

/** Snapshot the live memory core (USER/SUNNY/INDEX) so the eval rebuilds the SAME
 *  system prompt production used — without it the eval is missing ~half the prompt
 *  (incl. SUNNY.md's behavior conventions), which silently skews elicitation rates. */
function snapshotMemoryCore(): { user: string; sunny: string; index: string } {
  const runtimeDir = process.env.SUNNY_HOME ?? join(homedir(), '.sunny');
  const p = memoryPaths(runtimeDir);
  const read = (f: string): string => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  return { user: read(p.USER), sunny: read(p.SUNNY), index: read(p.INDEX) };
}

/**
 * Capture a REAL conversation turn from Postgres as an eval fixture (AGENTS.md:
 * "Reproduce loop/prompt/model bugs from REAL conversations"). Pulls a thread's
 * persisted rows — the verbatim `UIMessage` payloads, scratch + every tool part —
 * up to a chosen user message, and writes `{ input, turns }` where `turns` is the
 * prior history and `input` is the turn under test. Seed it into the eval via
 * `setup.fixtureTurns` (harness) and the loop replays the exact production context.
 *
 *   source .env   # DATABASE_URL + (to locate misses) LANGFUSE_* via the langfuse skill
 *   npx tsx evals/capture-turn.ts <threadId> [--input-id <messageId>] [--limit N] [--out path]
 *
 * Find a thread/message to capture with the langfuse skill — `delivery-recovery`
 * traces mark the missed turns; their `langfuseSessionId` IS the threadId.
 */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const threadId = process.argv[2];
  if (!threadId || threadId.startsWith('--')) {
    console.error('usage: tsx evals/capture-turn.ts <threadId> [--input-id <messageId>] [--limit N] [--out path]');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set — `source .env` first.');
    process.exit(2);
  }
  const limit = Number(flag('limit') ?? 250);
  const inputId = flag('input-id');

  const { db, pool } = createDb(url);
  try {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt));
    if (rows.length === 0) {
      console.error(`no messages for thread ${threadId}`);
      process.exit(1);
    }

    // The turn under test = the chosen user row (--input-id, else the latest user row).
    const inputIdx = inputId
      ? rows.findIndex((r) => r.messageId === inputId)
      : rows.map((r) => r.role).lastIndexOf('user');
    if (inputIdx < 0) {
      console.error(inputId ? `message ${inputId} not found` : 'no user message found');
      process.exit(1);
    }
    const inputRow = rows[inputIdx]!;
    if (inputRow.role !== 'user') {
      console.error(`message ${inputRow.messageId} is a ${inputRow.role} turn, not a user turn`);
      process.exit(1);
    }

    const turns: FixtureTurn[] = rows
      .slice(0, inputIdx)
      .slice(-limit)
      .map((r) => ({
        role: r.role as 'user' | 'assistant',
        text: r.text,
        ...(r.payload != null ? { payload: trimLongStrings(r.payload) } : {}),
      }));

    const fixture = {
      capturedFrom: { threadId, inputMessageId: inputRow.messageId },
      input: inputRow.text,
      memoryCore: snapshotMemoryCore(),
      turns,
    };
    const slug = inputRow.messageId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
    const out = flag('out') ?? join('evals/cases/fixtures/elicitation', `${slug}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(fixture));
    console.error(
      `wrote ${out}\n  ${turns.length} prior turns | input=${JSON.stringify(inputRow.text.slice(0, 70))}`,
    );
  } finally {
    await pool.end();
  }
}

void main();
