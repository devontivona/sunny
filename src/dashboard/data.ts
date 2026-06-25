import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messages, scheduleRuns, schedules } from '../db/schema.js';
import type { SunnyConfig } from '../config/index.js';
import { loadCore, memoryPaths, readTopic, sanitizeTopic } from '../memory/index.js';
import { listCredentials } from '../credentials/index.js';
import { listMcpServers, serverHost } from '../mcp/registry.js';
import { loadAllSkills, parseSkill, sanitizeSkillName } from '../skills/index.js';
import { toolCatalog } from '../agent/tools/catalog.js';
import { renderableMedia, type AttachmentKind } from '../gateway/media.js';

/**
 * Read-only data access for the dashboard (web-dashboard D-WD3/5). Reads the
 * memory files and Postgres through the gateway's shared runtime db. No method
 * here mutates Sunny's state; the only writes the dashboard makes are the auth
 * store (sessions/requests).
 */
export class DashboardData {
  constructor(
    private readonly db: Db,
    private readonly config: SunnyConfig,
    private readonly startedAt = Date.now(),
  ) {}

  // --- Memory --------------------------------------------------------------

  core() {
    const { sunny, user, index } = loadCore(memoryPaths(this.config.runtimeDir));
    return { sunny, user, index };
  }

  /** INDEX.md + the topic docs under topics/, with their INDEX router lines. */
  topics(): { index: string; topics: { name: string; summary: string | null }[] } {
    const paths = memoryPaths(this.config.runtimeDir);
    const index = loadCore(paths).index;
    const names = existsSync(paths.topicsDir)
      ? readdirSync(paths.topicsDir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.replace(/\.md$/, ''))
          .sort()
      : [];
    const summaries = parseIndexSummaries(index);
    return {
      index,
      topics: names.map((name) => ({ name, summary: summaries.get(name) ?? null })),
    };
  }

  topic(name: string): { name: string; content: string } | null {
    const safe = sanitizeTopic(name);
    const content = readTopic(memoryPaths(this.config.runtimeDir), safe);
    return content === null ? null : { name: safe, content };
  }

  // --- Capabilities (tools / credentials / skills) -------------------------
  // Observe-only directories (web-dashboard agent-tooling delta). Data-driven
  // from the live tool catalog, credential registry, and skill loader — no
  // values, no controls. Capabilities added by later tasks surface here for free.

  /** Registered tools: name + purpose + owner-only flag + input parameters. */
  tools(): { tools: ReturnType<typeof toolCatalog> } {
    return { tools: toolCatalog(this.config) };
  }

  /** The credential registry: names → `op://` references + purposes. References
   *  are pointers, never values (D-CR2/D-CR5) — no secret is ever served. */
  credentials(): { credentials: { name: string; reference: string; purpose: string | null }[] } {
    return {
      credentials: listCredentials(this.config.runtimeDir).map((c) => ({
        name: c.name,
        reference: c.reference,
        purpose: c.purpose ?? null,
      })),
    };
  }

  /** The MCP server registry (mcp D-MCP8): per server — name, host (NOT the
   *  token-bearing URL), transport, the auth reference BY NAME (never a value),
   *  enabled state, and the last-probed tool inventory. Data-driven from the registry,
   *  so a server added via `mcp_manage` surfaces here automatically. Observe-only. */
  mcpServers(): {
    servers: {
      name: string;
      host: string;
      transport: string;
      auth: string | null;
      enabled: boolean;
      purpose: string | null;
      probedAt: string | null;
      tools: { name: string; description: string }[];
    }[];
  } {
    return {
      servers: listMcpServers(this.config.runtimeDir).map((s) => ({
        name: s.name,
        host: serverHost(s.url),
        transport: s.transport,
        auth:
          s.auth?.kind === 'header'
            ? `header → ${s.auth.credential}`
            : s.auth?.kind === 'oauth'
              ? 'oauth'
              : null,
        enabled: s.enabled,
        purpose: s.purpose ?? null,
        probedAt: s.probe?.at ?? null,
        tools: s.probe?.tools ?? [],
      })),
    };
  }

  /** All skills across every root (primary + owned source repos), with description,
   *  trust tier, and source/provenance. */
  skills(): {
    skills: { name: string; description: string; trust: string; source: string | null }[];
  } {
    return {
      skills: loadAllSkills(this.config).map((s) => ({
        name: s.name,
        description: s.description,
        trust: s.trust,
        source: s.source ?? null,
      })),
    };
  }

  /** One skill in full: its metadata, the rendered SKILL.md body, and the other
   *  files in its directory (scripts/, references/, assets/). Resolves across all
   *  roots via the skill's own SKILL.md path. Observe-only. */
  skill(name: string): {
    name: string;
    description: string;
    trust: string;
    source: string | null;
    body: string;
    files: string[];
  } | null {
    let slug: string;
    try {
      slug = sanitizeSkillName(name);
    } catch {
      return null;
    }
    const record = loadAllSkills(this.config).find((r) => sanitizeSkillName(r.name) === slug);
    if (!record) return null;
    return {
      name: record.name,
      description: record.description,
      trust: record.trust,
      source: record.source ?? null,
      body: parseSkill(readFileSync(record.file, 'utf8')).body,
      files: listSkillFiles(dirname(record.file)),
    };
  }

  // --- Conversation --------------------------------------------------------

  async threads(limit = 50) {
    const grouped = await this.db
      .select({
        threadId: messages.threadId,
        lastAt: sql<string>`max(${messages.timestamp})`.as('last_at'),
        count: sql<number>`count(*)::int`.as('msg_count'),
      })
      .from(messages)
      .groupBy(messages.threadId)
      .orderBy(desc(sql`max(${messages.timestamp})`))
      .limit(limit);

    const out = [];
    for (const g of grouped) {
      const [latest] = await this.db
        .select()
        .from(messages)
        .where(eq(messages.threadId, g.threadId))
        .orderBy(desc(messages.timestamp))
        .limit(1);
      // Prefer a human's name for the label (assistant rows are all "Sunny").
      const [latestUser] = await this.db
        .select({ senderName: messages.senderName })
        .from(messages)
        .where(and(eq(messages.threadId, g.threadId), eq(messages.role, 'user')))
        .orderBy(desc(messages.timestamp))
        .limit(1);
      out.push({
        threadId: g.threadId,
        label: threadLabel(g.threadId, latestUser?.senderName ?? null),
        isGroup: isGroupThread(g.threadId),
        lastAt: new Date(g.lastAt).toISOString(),
        count: Number(g.count),
        preview: (latest?.text ?? '').slice(0, 120),
      });
    }
    return out;
  }

  async thread(threadId: string, limit = 50) {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(desc(messages.timestamp))
      .limit(limit);
    const ordered = rows.reverse();
    const userName = ordered.findLast((r) => r.role === 'user' && r.senderName)?.senderName ?? null;
    return {
      threadId,
      label: threadLabel(threadId, userName),
      messages: ordered.map(toConversationMessage),
    };
  }

  async search(query: string, limit = 25) {
    if (!query.trim()) return { results: [] };
    const rows = await this.db
      .select()
      .from(messages)
      .where(sql`"text_search" @@ plainto_tsquery('english', ${query})`)
      .orderBy(desc(messages.timestamp))
      .limit(limit);
    return {
      results: rows.map((r) => ({
        id: r.id,
        threadId: r.threadId,
        role: r.role as 'user' | 'assistant',
        timestamp: r.timestamp.toISOString(),
        senderName: r.senderName ?? null,
        text: r.text,
      })),
    };
  }

  // --- Schedules & runs ----------------------------------------------------

  async schedules(runLimit = 10) {
    const rows = await this.db.select().from(schedules).orderBy(desc(schedules.createdAt));
    const out = [];
    for (const s of rows) {
      const runs = await this.db
        .select()
        .from(scheduleRuns)
        .where(eq(scheduleRuns.scheduleId, s.id))
        .orderBy(desc(scheduleRuns.firedAt))
        .limit(runLimit);
      out.push({
        id: s.id,
        kind: s.kind,
        spec: s.spec,
        label: s.label,
        prompt: s.prompt,
        threadId: s.threadId,
        timezone: s.timezone,
        active: s.active,
        nextRunAt: s.nextRunAt?.toISOString() ?? null,
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
        runs: runs.map((r) => ({
          id: r.id,
          firedAt: r.firedAt.toISOString(),
          status: r.status,
          output: r.output,
          error: r.error,
        })),
      });
    }
    return out;
  }

  // --- Durable jobs (WDK runs) ---------------------------------------------
  // Observe-only view of the Workflow DevKit world: background jobs (start_job →
  // runJob) and scheduled runs (runScheduledJob) are durable workflow runs recorded
  // in the `workflow.*` schema. The dashboard surfaces them so a job that hangs or
  // fails is visible (previously there was no signal anywhere). Read-only; the WDK
  // tables aren't in the app's drizzle schema, so this reads them with raw SQL.

  async jobs(limit = 30): Promise<{
    jobs: {
      id: string;
      kind: string;
      name: string;
      status: string;
      createdAt: string;
      startedAt: string | null;
      completedAt: string | null;
      durationMs: number | null;
      stepCount: number;
      failedSteps: number;
    }[];
  }> {
    const res = await this.db.execute(sql`
      select r.id, r.name, r.status, r.created_at, r.started_at, r.completed_at,
        (select count(*)::int from workflow.workflow_steps s where s.run_id = r.id) as step_count,
        (select count(*)::int from workflow.workflow_steps s
           where s.run_id = r.id and s.status = 'failed') as failed_steps
      from workflow.workflow_runs r
      order by r.created_at desc
      limit ${limit}
    `);
    const rows = (res as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    return {
      jobs: rows.map((r) => {
        const startedAt = iso(r.started_at);
        const completedAt = iso(r.completed_at);
        return {
          id: String(r.id),
          kind: jobKind(String(r.name)),
          name: String(r.name),
          status: String(r.status),
          createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
          startedAt,
          completedAt,
          durationMs:
            startedAt && completedAt
              ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
              : null,
          stepCount: Number(r.step_count ?? 0),
          failedSteps: Number(r.failed_steps ?? 0),
        };
      }),
    };
  }

  // --- Activity & health ---------------------------------------------------

  async activity(limit = 50) {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.role, 'assistant'))
      .orderBy(desc(messages.timestamp))
      .limit(limit);
    return {
      turns: rows.map((r) => {
        const meta = metaOf(r.payload);
        return {
          id: r.id,
          threadId: r.threadId,
          timestamp: r.timestamp.toISOString(),
          model: typeof meta.model === 'string' ? meta.model : null,
          delivery: typeof meta.delivered === 'string' ? meta.delivered : null,
          // Whether the delivery-recovery backstop fired this turn (D-MG8). A
          // healthy system trends this toward zero; track it to catch elicitation
          // regressions early.
          recovered: meta.recovered === true,
          steps: typeof meta.steps === 'number' ? meta.steps : null,
          usage: normalizeUsage(meta.usage),
        };
      }),
    };
  }

  async health() {
    const now = Date.now();
    // Database ping.
    let database = { ok: false, detail: 'unreachable' };
    try {
      await this.db.execute(sql`select 1`);
      database = { ok: true, detail: 'connected' };
    } catch (err) {
      database = { ok: false, detail: String(err).slice(0, 120) };
    }

    // Scheduler liveness: a far-overdue active schedule implies the gateway's
    // ticker isn't firing. (The ticker itself lives in the gateway process.)
    let scheduler = { ok: true, detail: 'idle' };
    let unprocessedInbound = 0;
    try {
      const active = await this.db.select().from(schedules).where(eq(schedules.active, true));
      const overdue = active.filter((s) => s.nextRunAt && s.nextRunAt.getTime() < now - 5 * 60_000);
      scheduler = {
        ok: overdue.length === 0,
        detail:
          overdue.length === 0
            ? `${active.length} active`
            : `${overdue.length} overdue — ticker may be stalled`,
      };
      const [cnt] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.role, 'user'), isNull(messages.processedAt)));
      unprocessedInbound = Number(cnt?.n ?? 0);
    } catch {
      scheduler = { ok: false, detail: 'query failed' };
    }

    // The gateway shares this process now (folded into Nitro, D-WD1) — if these
    // routes are serving, the gateway runtime is up. Surface inbound backlog as
    // the meaningful liveness signal via `unprocessedInbound` below.
    const gateway = { ok: true, detail: 'in-process' };

    const uptime = Math.round((now - this.startedAt) / 1000);
    return {
      service: { ok: true, detail: `up ${formatDuration(uptime)}` },
      database,
      scheduler,
      gateway,
      unprocessedInbound,
      generatedAt: new Date().toISOString(),
    };
  }
}

// --- helpers ---------------------------------------------------------------

/** List every file in a skill directory as sorted, dir-relative paths (e.g.
 *  `SKILL.md`, `scripts/build.sh`, `assets/theme.css`) — so the dashboard can show
 *  what else ships with a skill beyond SKILL.md. */
function listSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(r);
      else if (entry.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** Humanize a WDK run name (`workflow//./workflows/job//runJob`) for display. */
function jobKind(name: string): string {
  if (name.endsWith('runJob')) return 'Background job';
  if (name.endsWith('runScheduledJob')) return 'Scheduled job';
  return name.split('//').filter(Boolean).pop() ?? name;
}

/** Parse `- name — summary` / `name: summary` lines from INDEX.md. */
function parseIndexSummaries(index: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of index.split('\n')) {
    const m = /(?:topics\/)?([a-z0-9_-]+)(?:\.md)?\s*[—:–-]\s*(.+)$/i.exec(line.trim());
    if (m && m[1] && m[2]) map.set(sanitizeTopic(m[1]), m[2].trim());
  }
  return map;
}

/** Pretty-print a duration in seconds as the two largest units (e.g. "3d 4h", "45m"). */
function formatDuration(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && parts.length < 2) parts.push(`${s}s`);
  return parts.slice(0, 2).join(' ') || '0s';
}

function isGroupThread(threadId: string): boolean {
  return threadId.split(':')[2] === 'g';
}

function threadLabel(threadId: string, senderName: string | null): string {
  if (isGroupThread(threadId)) {
    const gid = threadId.split(':')[3] ?? '';
    return `Group ${gid.slice(0, 8)}`;
  }
  if (senderName) return senderName;
  // Sendblue encodes the contact as base64 of the phone number — decode it to a
  // short, human-readable number rather than showing the raw base64 blob.
  const tail = threadId.split(':').pop() ?? threadId;
  try {
    const decoded = Buffer.from(tail, 'base64').toString('utf8');
    if (/^\+?[0-9]{7,15}$/.test(decoded)) return decoded;
  } catch {
    /* not base64 — fall through */
  }
  return tail;
}

interface UiPart {
  type: string;
  text?: string;
  input?: { text?: string };
}

function metaOf(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && 'metadata' in payload) {
    const m = (payload as { metadata?: unknown }).metadata;
    if (m && typeof m === 'object') return m as Record<string, unknown>;
  }
  return {};
}

function partsOf(payload: unknown): UiPart[] {
  if (payload && typeof payload === 'object' && 'parts' in payload) {
    const p = (payload as { parts?: unknown }).parts;
    if (Array.isArray(p)) return p as UiPart[];
  }
  return [];
}

function normalizeUsage(usage: unknown) {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return { in: num(u.in), out: num(u.out), cached: num(u.cached), cacheWrite: num(u.cacheWrite) };
}

/**
 * Renderable image attachments for a row (messaging-media D-MM9). Disk-backed
 * media (inbound, or durable outbound copies) is served through the authenticated
 * dashboard route, addressed by row id + index; an external URL is rendered as-is.
 */
function mediaAttachments(rowId: string, payload: unknown) {
  const out: { kind: AttachmentKind; mediaType: string; name: string; src: string }[] = [];
  renderableMedia(payload).forEach((m, i) => {
    const src = m.disk ? `/dashboard/api/media?msg=${encodeURIComponent(rowId)}&i=${i}` : m.url;
    if (src) out.push({ kind: m.kind, mediaType: m.mediaType, name: m.name, src });
  });
  return out;
}

/** Turn a stored message row into the dashboard's conversation shape (D-WD3). */
function toConversationMessage(row: typeof messages.$inferSelect) {
  const parts = partsOf(row.payload);
  const meta = metaOf(row.payload);
  const attachments = mediaAttachments(row.id, row.payload);
  if (row.role === 'user') {
    const text = parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text as string)
      .join('\n');
    return {
      id: row.id,
      role: 'user' as const,
      timestamp: row.timestamp.toISOString(),
      senderName: row.senderName ?? null,
      delivered: [text || row.text].filter(Boolean),
      attachments,
      scratch: null,
      delivery: null,
      steps: null,
      usage: null,
    };
  }
  // Assistant: delivered = each send_message; scratch = private text parts.
  const delivered = parts
    .filter((p) => p.type === 'tool-send_message' && p.input?.text)
    .map((p) => p.input!.text as string);
  const scratch = parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text as string)
    .join('\n')
    .trim();
  return {
    id: row.id,
    role: 'assistant' as const,
    timestamp: row.timestamp.toISOString(),
    senderName: row.senderName ?? null,
    delivered: delivered.length > 0 ? delivered : row.text ? [row.text] : [],
    attachments,
    scratch: scratch || null,
    delivery: typeof meta.delivered === 'string' ? meta.delivered : null,
    steps: typeof meta.steps === 'number' ? meta.steps : null,
    usage: normalizeUsage(meta.usage),
  };
}
