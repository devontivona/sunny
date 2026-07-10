import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { and, asc, desc, eq, isNull, lte, notLike, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { dreamState, messages, threadCompactions } from '../db/schema.js';
import type { SunnyConfig } from '../config/index.js';
import { indexHasTopicLine, memoryPaths, personId } from '../memory/index.js';
import { stripBinaryRuns } from '../agent/delivery.js';

/**
 * The `sunny dream` subcommands (context-lifecycle): the dreaming job's DETERMINISTIC
 * operations, owned by the repo (typed, tested) — never skill prose. The skill decides
 * WHAT to memorize and WHERE to cut; these commands decide what is true and what is valid.
 *
 * - `digest`  — everything said since the global dream watermark, grouped per thread with
 *               attribution, attachment paths, bounded tool traces, lull markers, prior
 *               compaction summaries, and a suggested compaction boundary per thread.
 * - `compact` — write one thread's compaction summary, guarded by the full validation
 *               matrix (the correctness-critical half of the feature).
 * - `advance` — move the global watermark to a covered-through row.
 *
 * Functions are importable and integration-tested without spawning a process; the CLI
 * entry (`src/cli/index.ts`) is a thin parser. Failures throw `CliError` with a message
 * written for a MODEL to read and correct from; the entry maps them to non-zero exits.
 */

/** A validation/usage failure the model can act on (exit 1, message on stderr). */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** The single global watermark row id (`dream_state` is a one-row table). */
const GLOBAL = 'global';

/** Inter-message gap above which the digest renders a lull marker (episode-boundary hint). */
const LULL_THRESHOLD_MS = 30 * 60_000;

/** Bounded rendering caps — one huge row must not eat the whole digest. */
const ROW_TEXT_MAX_CHARS = 4000;
const TOOL_TRACE_MAX = 12;
const TOOL_TRACE_CHARS = 160;
/** Row-fetch bound for the span query; the char cap is the real limiter, this just keeps
 *  a pathological backlog from ballooning memory. Hitting it reports a partial cover. */
const SPAN_ROW_LIMIT = 2000;
/** Newest-first rows examined per thread for the boundary suggestion. */
const BOUNDARY_SCAN_LIMIT = 500;

// --- shared row shapes -------------------------------------------------------------

export interface DigestRow {
  threadId: string;
  messageId: string;
  role: string;
  senderId: string;
  senderName: string | null;
  /** From the stored row — drives the deterministic "(owner)" attribution tag. */
  isOwner: boolean;
  text: string;
  payload: unknown;
  createdAt: Date;
}

export interface ThreadSection {
  threadId: string;
  rows: DigestRow[];
  /** The thread's current compaction summary (what the next summary must fold forward). */
  priorSummary: { summary: string; boundaryCreatedAt: Date } | null;
  suggestion: BoundarySuggestion | null;
}

export interface BoundarySuggestion {
  messageId: string;
  createdAt: Date;
  role: string;
  /** Estimated tokens of verbatim tail left if compacted exactly here. */
  tailTokens: number;
  /** Estimated tokens of the thread's whole uncompacted tail right now. */
  totalTokens: number;
}

export interface IndexLint {
  /** Topic docs on disk with no INDEX routing line (pre-invariant legacy). */
  missingFromIndex: string[];
  /** INDEX bullet slugs whose topic doc no longer exists. */
  staleIndexLines: string[];
  /** INDEX lines still carrying the auto-added "(stub …)" marker — need a real description. */
  stubLines: string[];
}

export interface DigestInput {
  now: Date;
  watermark: { createdAt: Date; messageId: string } | null;
  threads: ThreadSection[];
  indexLint: IndexLint;
  /** True when the span was cut by the char/row cap (older-first partial cover). */
  partial: boolean;
  /** The newest row INCLUDED — what `advance` should move the watermark to. */
  coveredThrough: { threadId: string; messageId: string; createdAt: Date } | null;
  tokenTarget: number;
  repoRoot: string;
}

// --- token estimation + boundary suggestion (pure) ----------------------------------

/** Rough token estimate for one stored row: payload-chars/4 (the payload is what actually
 *  replays into the prompt), falling back to the text projection. */
export function estimateRowTokens(row: { text: string; payload: unknown }): number {
  let chars = row.text.length;
  if (row.payload != null) {
    try {
      chars = JSON.stringify(row.payload).length;
    } catch {
      /* keep the text estimate */
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Suggest a compaction boundary for one thread (pure): walking newest→oldest over the
 * thread's uncompacted tail, the FIRST row at which the accumulated tail estimate reaches
 * the token target — compacting there leaves ≈ target tokens verbatim. A CEILING, not a
 * cut point: the dream compacts at the nearest conversational seam AT-OR-BEFORE it.
 * Rows fresher than the margin can't be boundaries (compact would refuse), so they count
 * toward the tail but are never suggested. Returns null when the tail is under target.
 */
export function suggestBoundary(
  rowsNewestFirst: Array<{
    messageId: string;
    createdAt: Date;
    role: string;
    tokens: number;
  }>,
  tokenTarget: number,
  freshCutoff: Date,
): BoundarySuggestion | null {
  let acc = 0;
  let suggestion: BoundarySuggestion | null = null;
  for (const row of rowsNewestFirst) {
    acc += row.tokens;
    if (suggestion === null && acc >= tokenTarget && row.createdAt < freshCutoff) {
      suggestion = {
        messageId: row.messageId,
        createdAt: row.createdAt,
        role: row.role,
        tailTokens: acc - row.tokens,
        totalTokens: 0, // filled below
      };
    }
  }
  if (!suggestion) return null;
  return { ...suggestion, totalTokens: acc };
}

// --- INDEX lint (pure over the loaded body + slug list) ------------------------------

/**
 * The INDEX↔topics consistency check (detection ONLY — deterministic, repo-owned). Fixes
 * are deliberately NOT automated: adding/upgrading a line needs judgement (a real
 * description of what the doc holds), and every INDEX mutation must go through
 * `memory_write` (the serialized writer + cap enforcement + git commit), never a CLI
 * editing the file. Embedded in every digest and exposed standalone as `dream lint` so
 * the dream can verify its fixes without re-printing a whole digest.
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
 *  INDEX LINT section and the standalone `dream lint` command. */
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

// --- digest rendering (pure) ---------------------------------------------------------

/** One bounded line per tool part in an assistant row's payload — the digest's view of
 *  what the turn DID (its `text` head already carries what it said). */
export function toolTraceLines(payload: unknown): string[] {
  const parts = (payload as { parts?: Array<Record<string, unknown>> } | null)?.parts;
  if (!Array.isArray(parts)) return [];
  const lines: string[] = [];
  let more = 0;
  for (const p of parts) {
    const type = typeof p.type === 'string' ? p.type : '';
    if (!type.startsWith('tool-')) continue;
    if (lines.length >= TOOL_TRACE_MAX) {
      more++;
      continue;
    }
    let input = '';
    try {
      input = typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? '');
    } catch {
      input = '';
    }
    const brief = stripBinaryRuns(input).replace(/\s+/g, ' ');
    const clipped =
      brief.length > TOOL_TRACE_CHARS ? `${brief.slice(0, TOOL_TRACE_CHARS)}…` : brief;
    lines.push(`    tool ${type.slice('tool-'.length)}: ${clipped}`);
  }
  if (more > 0) lines.push(`    (… ${more} more tool calls)`);
  return lines;
}

/** Attachment lines for a digest row (name + saved path — the permanence contract). */
function digestAttachmentLines(payload: unknown): string[] {
  const parts = (payload as { parts?: Array<Record<string, unknown>> } | null)?.parts;
  if (!Array.isArray(parts)) return [];
  const lines: string[] = [];
  for (const p of parts) {
    if (p.type !== 'data-attachment') continue;
    const ref = p.data as { name?: string; mediaType?: string; path?: string | null } | undefined;
    if (!ref) continue;
    lines.push(
      ref.path
        ? `    attachment: ${ref.name} (${ref.mediaType}) — saved at ${ref.path}`
        : `    attachment: ${ref.name} (${ref.mediaType}) — not saved`,
    );
  }
  return lines;
}

/** The spoken/narration head of a row's text projection — the `[tool results]` extract
 *  (projection v2) is re-derived as bounded traces instead of replayed wholesale. */
export function spokenHead(text: string): string {
  const head = text.split('\n[tool results]\n')[0] ?? text;
  return head.length > ROW_TEXT_MAX_CHARS ? `${head.slice(0, ROW_TEXT_MAX_CHARS)}…(clipped)` : head;
}

/**
 * Deterministic speaker attribution so the dream never GUESSES memory routing: the owner's
 * messages are tagged "(owner)" (their facts → USER.md); every other human participant is
 * rendered with their people-doc handle (their facts → memory_write file "people:<id>") —
 * the same `personId` derivation the runtime uses, so the handle always hits the right doc.
 */
export function whoOf(row: {
  role: string;
  senderId: string;
  senderName: string | null;
  isOwner: boolean;
}): string {
  if (row.role === 'assistant') return 'Sunny';
  const name = row.senderName ?? row.senderId;
  if (row.isOwner) return `${name} (owner)`;
  try {
    return `${name} [people:${personId(row.senderId)}]`;
  } catch {
    return name; // an identity that slugs to nothing — attribute by name only
  }
}

function fmtTs(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

function fmtLull(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(ms / 60_000)}m`;
}

/** Render one thread's digest section (pure; unit-tested). */
export function renderThreadSection(section: ThreadSection, tokenTarget: number): string {
  const lines: string[] = [];
  lines.push(`--- THREAD ${section.threadId} — ${section.rows.length} new message(s) ---`);
  if (section.priorSummary) {
    lines.push(
      `Prior compaction summary (covers through ${fmtTs(section.priorSummary.boundaryCreatedAt)}) — fold it forward, don't lose it:`,
    );
    lines.push(...section.priorSummary.summary.split('\n').map((l) => `  | ${l}`));
  }
  lines.push('');
  let prev: Date | null = null;
  for (const row of section.rows) {
    if (prev && row.createdAt.getTime() - prev.getTime() > LULL_THRESHOLD_MS) {
      lines.push(`— lull: ${fmtLull(row.createdAt.getTime() - prev.getTime())} —`);
    }
    prev = row.createdAt;
    lines.push(
      `[${fmtTs(row.createdAt)}] ${whoOf(row)} [id:${row.messageId}]: ${spokenHead(row.text)}`,
    );
    lines.push(...digestAttachmentLines(row.payload));
    if (row.role === 'assistant') lines.push(...toolTraceLines(row.payload));
  }
  lines.push('');
  if (section.suggestion) {
    const s = section.suggestion;
    lines.push(
      `Suggested compaction boundary: [id:${s.messageId}] ${fmtTs(s.createdAt)} (${s.role === 'assistant' ? 'an assistant turn' : 'a user message — cut EARLIER, after an assistant turn'}) — ` +
        `compacting here leaves ~${Math.round(s.tailTokens / 1000)}k tokens of verbatim tail ` +
        `(tail now ~${Math.round(s.totalTokens / 1000)}k, target ${Math.round(tokenTarget / 1000)}k). ` +
        `This is a CEILING: cut at the nearest conversational seam at-or-before it.`,
    );
  } else {
    lines.push(
      `Tail under the ${Math.round(tokenTarget / 1000)}k-token target — no compaction needed.`,
    );
  }
  return lines.join('\n');
}

/** The idle marker `dream digest` prints when nothing is new (the skill short-circuits on it). */
export const IDLE_MARKER = 'IDLE: nothing new since the last dream watermark.';

/** Render the whole digest (pure; unit-tested). */
export function renderDigest(input: DigestInput): string {
  if (input.threads.length === 0) {
    return `${IDLE_MARKER}\n(watermark: ${input.watermark ? `${input.watermark.createdAt.toISOString()} [id:${input.watermark.messageId}]` : 'none — first dream'})`;
  }
  const lines: string[] = [];
  lines.push('=== DREAM DIGEST ===');
  lines.push(
    `Watermark: ${input.watermark ? `${input.watermark.createdAt.toISOString()} [id:${input.watermark.messageId}]` : 'none — first dream (covering from the beginning)'}`,
  );
  if (input.partial) {
    lines.push(
      `PARTIAL: the unprocessed span exceeded the digest cap — this digest covers the OLDEST content first. ` +
        `Process it, advance to the covered-through row below, and the next dream continues from there.`,
    );
  }
  lines.push('');
  for (const section of input.threads) {
    lines.push(renderThreadSection(section, input.tokenTarget));
    lines.push('');
  }
  lines.push('=== INDEX LINT ===');
  lines.push(renderLintReport(input.indexLint));
  lines.push('');
  lines.push('=== WHEN DONE ===');
  if (input.coveredThrough) {
    lines.push(
      'After memorizing (and compacting where suggested), advance the watermark EXACTLY so:',
    );
    lines.push(
      `  cd ${input.repoRoot} && npx tsx src/cli/index.ts dream advance --thread '${input.coveredThrough.threadId}' --message '${input.coveredThrough.messageId}'`,
    );
  }
  return lines.join('\n');
}

// --- data gathering + the three commands ---------------------------------------------

async function readWatermark(db: Db): Promise<{ createdAt: Date; messageId: string } | null> {
  const rows = await db.select().from(dreamState).where(eq(dreamState.id, GLOBAL)).limit(1);
  const row = rows[0];
  return row
    ? { createdAt: row.coveredThroughCreatedAt, messageId: row.coveredThroughMessageId }
    : null;
}

/**
 * PRECISION RULE: Postgres timestamps carry MICROSECONDS; a JS `Date` truncates to
 * milliseconds. A tuple that round-trips through JS compares LOWER than the stored value,
 * so the covered/boundary row itself would leak back into every span/window. Every tuple
 * comparison against a stored watermark therefore happens IN SQL against the source row
 * (subquery), and every watermark write copies the tuple in SQL — never through a Date.
 */
const dreamWatermarkTuple = sql`(SELECT ${dreamState.coveredThroughCreatedAt}, ${dreamState.coveredThroughMessageId} FROM ${dreamState} WHERE ${dreamState.id} = ${GLOBAL})`;

const compactionTupleById = (id: string) =>
  sql`(SELECT ${threadCompactions.boundaryCreatedAt}, ${threadCompactions.boundaryMessageId} FROM ${threadCompactions} WHERE ${threadCompactions.id} = ${id})`;

const messageTuple = (threadId: string, messageId: string) =>
  sql`(SELECT ${messages.createdAt}, ${messages.messageId} FROM ${messages} WHERE ${messages.threadId} = ${threadId} AND ${messages.messageId} = ${messageId})`;

async function latestCompactionRow(db: Db, threadId: string) {
  const rows = await db
    .select()
    .from(threadCompactions)
    .where(eq(threadCompactions.threadId, threadId))
    .orderBy(desc(threadCompactions.seq))
    .limit(1);
  return rows[0] ?? null;
}

/** Gather + render the dream digest. `now` is injectable for tests. */
export async function digest(db: Db, config: SunnyConfig, now: Date = new Date()): Promise<string> {
  const watermark = await readWatermark(db);
  const freshCutoff = new Date(now.getTime() - config.dream.marginMinutes * 60_000);

  const conds = [notLike(messages.threadId, 'subagent:%'), lte(messages.createdAt, freshCutoff)];
  if (watermark) {
    // Compared against the STORED tuple in SQL (see the precision rule above) — a
    // JS-roundtripped Date would re-include the covered-through row forever.
    conds.push(sql`(${messages.createdAt}, ${messages.messageId}) > ${dreamWatermarkTuple}`);
  }
  const span = await db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(asc(messages.createdAt), asc(messages.messageId))
    .limit(SPAN_ROW_LIMIT);

  // Char-cap the span oldest-first (a first dream can face weeks of backlog): estimate
  // each row's rendered footprint and stop once the digest budget is spent. Everything
  // included is coverable; `coveredThrough` is the newest included row.
  let budget = config.dream.digestMaxChars;
  const included: typeof span = [];
  for (const row of span) {
    const cost = Math.min(row.text.length, ROW_TEXT_MAX_CHARS) + 200;
    if (budget - cost < 0 && included.length > 0) break;
    budget -= cost;
    included.push(row);
  }
  const partial = included.length < span.length || span.length === SPAN_ROW_LIMIT;

  const byThread = new Map<string, typeof included>();
  for (const row of included) {
    const list = byThread.get(row.threadId) ?? [];
    list.push(row);
    byThread.set(row.threadId, list);
  }

  const threads: ThreadSection[] = [];
  for (const [threadId, rows] of byThread) {
    const compaction = await latestCompactionRow(db, threadId);
    // The boundary suggestion looks at the thread's WHOLE uncompacted tail (fresh rows
    // included — they count toward the tail but can't be boundaries).
    const tailConds = [eq(messages.threadId, threadId)];
    if (compaction) {
      tailConds.push(
        sql`(${messages.createdAt}, ${messages.messageId}) > ${compactionTupleById(compaction.id)}`,
      );
    }
    const tail = await db
      .select({
        messageId: messages.messageId,
        createdAt: messages.createdAt,
        role: messages.role,
        text: messages.text,
        payload: messages.payload,
      })
      .from(messages)
      .where(and(...tailConds))
      .orderBy(desc(messages.createdAt), desc(messages.messageId))
      .limit(BOUNDARY_SCAN_LIMIT);
    const suggestion = suggestBoundary(
      tail.map((r) => ({
        messageId: r.messageId,
        createdAt: r.createdAt,
        role: r.role,
        tokens: estimateRowTokens(r),
      })),
      config.windowTailTokenTarget,
      freshCutoff,
    );
    threads.push({
      threadId,
      rows: rows.map((r) => ({
        threadId: r.threadId,
        messageId: r.messageId,
        role: r.role,
        senderId: r.senderId,
        senderName: r.senderName,
        isOwner: r.isOwner,
        text: r.text,
        payload: r.payload,
        createdAt: r.createdAt,
      })),
      priorSummary: compaction
        ? { summary: compaction.summary, boundaryCreatedAt: compaction.boundaryCreatedAt }
        : null,
      suggestion,
    });
  }

  const last = included[included.length - 1];
  return renderDigest({
    now,
    watermark,
    threads,
    indexLint: lintIndexFromDisk(config),
    partial,
    coveredThrough: last
      ? { threadId: last.threadId, messageId: last.messageId, createdAt: last.createdAt }
      : null,
    tokenTarget: config.windowTailTokenTarget,
    repoRoot: process.cwd(),
  });
}

/** The standalone `dream lint` command: the same report the digest embeds, recomputed
 *  from the live memory tree — the dream's verify-after-fix loop (re-run until clean).
 *  Detection only; fixes go through memory_write (see lintIndex). */
export function lint(config: SunnyConfig): string {
  return renderLintReport(lintIndexFromDisk(config));
}

/** INDEX lint against the live memory tree (topics/ dir + INDEX.md). */
function lintIndexFromDisk(config: SunnyConfig): IndexLint {
  const paths = memoryPaths(config.runtimeDir);
  const indexBody = existsSync(paths.INDEX) ? readFileSync(paths.INDEX, 'utf8') : '';
  const slugs = existsSync(paths.topicsDir)
    ? readdirSync(paths.topicsDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -'.md'.length))
    : [];
  return lintIndex(indexBody, slugs);
}

export interface CompactArgs {
  threadId: string;
  /** The boundary row's message id (its `(created_at, message_id)` tuple is derived). */
  boundaryMessageId: string;
  summary: string;
}

/**
 * Write one thread's compaction summary — after the FULL validation matrix (design
 * decision 4). Every refusal throws `CliError` with a reason the model can correct from.
 */
export async function compact(
  db: Db,
  config: SunnyConfig,
  args: CompactArgs,
  now: Date = new Date(),
): Promise<string> {
  const { threadId, boundaryMessageId } = args;
  const summary = args.summary.trim();

  if (threadId.startsWith('subagent:')) {
    throw new CliError(
      `refused: ${threadId} is an internal subagent inbox — only real conversation threads are compacted.`,
    );
  }
  if (!summary) throw new CliError('refused: the summary is empty.');
  if (summary.length > config.dream.summaryMaxChars) {
    throw new CliError(
      `refused: summary is ${summary.length} chars, over the ${config.dream.summaryMaxChars} cap — tighten it and retry.`,
    );
  }

  const boundaryRows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.messageId, boundaryMessageId)))
    .limit(1);
  const boundary = boundaryRows[0];
  if (!boundary) {
    throw new CliError(
      `refused: no message with id "${boundaryMessageId}" exists in thread ${threadId} — use an [id:…] from the digest.`,
    );
  }

  const freshCutoff = new Date(now.getTime() - config.dream.marginMinutes * 60_000);
  if (boundary.createdAt > freshCutoff) {
    throw new CliError(
      `refused: boundary row is newer than the ${config.dream.marginMinutes}-minute freshness margin — pick an older boundary.`,
    );
  }

  // THE load-bearing guard: a covered-but-unanswered user message would keep
  // `hasUnansweredInbound` true forever while never appearing in any window → the router
  // re-runs the thread in a hot loop. Never compact what a turn still owes an answer.
  // The at-or-before comparison happens in SQL against the boundary row itself (precision
  // rule) — a JS-truncated Date would let an unanswered BOUNDARY row slip past the guard.
  const boundaryTuple = messageTuple(threadId, boundaryMessageId);
  const unanswered = await db
    .select({ messageId: messages.messageId })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.role, 'user'),
        isNull(messages.processedAt),
        sql`(${messages.createdAt}, ${messages.messageId}) <= ${boundaryTuple}`,
      ),
    )
    .limit(1);
  if (unanswered.length > 0) {
    throw new CliError(
      `refused: an unanswered user message (id ${unanswered[0]!.messageId}) is at-or-before this boundary — ` +
        `compacting would hide it from the turn that must answer it. Pick an earlier boundary or skip this thread.`,
    );
  }

  const current = await latestCompactionRow(db, threadId);
  if (current) {
    // Full-precision tuple comparison in SQL (precision rule + DB collation on ties).
    const cmp = await db.execute<{ backward: boolean }>(sql`
      SELECT (b.created_at, b.message_id) < (c.boundary_created_at, c.boundary_message_id) AS backward
      FROM ${messages} b, ${threadCompactions} c
      WHERE b.thread_id = ${threadId} AND b.message_id = ${boundaryMessageId} AND c.id = ${current.id}
    `);
    if (cmp.rows[0]?.backward) {
      throw new CliError(
        `refused: boundary is older than the thread's current watermark (${current.boundaryCreatedAt.toISOString()} [id:${current.boundaryMessageId}]) — compaction only moves forward.`,
      );
    }
  }

  // INSERT … SELECT so the stored boundary tuple is copied at FULL precision from the
  // boundary row (never through a millisecond-truncated JS Date — the boundary row would
  // otherwise replay in every window while also being covered by the summary).
  await db.execute(sql`
    INSERT INTO ${threadCompactions} (thread_id, boundary_created_at, boundary_message_id, summary)
    SELECT ${threadId}, ${messages.createdAt}, ${messages.messageId}, ${summary}
    FROM ${messages}
    WHERE ${messages.threadId} = ${threadId} AND ${messages.messageId} = ${boundaryMessageId}
  `);
  return (
    `ok: compacted ${threadId} through ${boundary.createdAt.toISOString()} [id:${boundary.messageId}] ` +
    `(summary ${summary.length} chars). Raw rows are untouched; the window now replays this summary + the tail.`
  );
}

export interface AdvanceArgs {
  threadId: string;
  messageId: string;
}

/** Upsert the global dream watermark to a covered-through row (forward-only). */
export async function advance(db: Db, args: AdvanceArgs): Promise<string> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, args.threadId), eq(messages.messageId, args.messageId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new CliError(
      `refused: no message with id "${args.messageId}" in thread ${args.threadId} — use the exact advance command the digest printed.`,
    );
  }
  const current = await readWatermark(db);
  if (current) {
    // Full-precision tuple comparison in SQL (precision rule).
    const cmp = await db.execute<{ backward: boolean }>(sql`
      SELECT (m.created_at, m.message_id) < (d.covered_through_created_at, d.covered_through_message_id) AS backward
      FROM ${messages} m, ${dreamState} d
      WHERE m.thread_id = ${args.threadId} AND m.message_id = ${args.messageId} AND d.id = ${GLOBAL}
    `);
    if (cmp.rows[0]?.backward) {
      throw new CliError(
        `refused: that row is behind the current watermark (${current.createdAt.toISOString()} [id:${current.messageId}]) — the watermark only moves forward.`,
      );
    }
  }
  // INSERT … SELECT copies the covered-through tuple at FULL precision from the source
  // row (precision rule) — an upsert built from a JS Date would leave the covered row
  // permanently "newer than the watermark" and re-digested every dream.
  await db.execute(sql`
    INSERT INTO ${dreamState} (id, covered_through_created_at, covered_through_message_id, updated_at)
    SELECT ${GLOBAL}, ${messages.createdAt}, ${messages.messageId}, now()
    FROM ${messages}
    WHERE ${messages.threadId} = ${args.threadId} AND ${messages.messageId} = ${args.messageId}
    ON CONFLICT (id) DO UPDATE SET
      covered_through_created_at = EXCLUDED.covered_through_created_at,
      covered_through_message_id = EXCLUDED.covered_through_message_id,
      updated_at = EXCLUDED.updated_at
  `);
  return `ok: dream watermark advanced to ${row.createdAt.toISOString()} [id:${row.messageId}].`;
}
