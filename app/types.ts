import type { UIMessage } from 'ai';

// JSON shapes returned by the dashboard's read-only API (src/dashboard/api/*).
// Kept in sync by hand with the server transforms — the app and server build
// under different tsconfigs, so they don't share a module.

/** The AI SDK message parts (tool calls, results, text, step boundaries) — the
 *  shape both the live stream and persisted turns render via `<MessageParts>`. */
export type UIPart = UIMessage['parts'][number];

export interface MemoryCore {
  sunny: string;
  user: string;
  index: string;
}

export interface TopicSummary {
  name: string;
  /** The INDEX.md router line for this topic, if present. */
  summary: string | null;
}

export interface TopicDoc {
  name: string;
  content: string;
}

export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ToolEntry {
  name: string;
  purpose: string;
  ownerOnly: boolean;
  params: ToolParam[];
}

export interface ToolsView {
  tools: ToolEntry[];
}

export interface CredentialEntry {
  name: string;
  /** `op://vault/item/field` reference — a pointer, never the value. */
  reference: string;
  purpose: string | null;
}

export interface CredentialsView {
  credentials: CredentialEntry[];
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpServerView {
  name: string;
  /** Server host only — never the full token-bearing URL (D-MCP8). */
  host: string;
  transport: string;
  /** Auth reference by name (e.g. `header → craft-token`) or `oauth`; never a value. */
  auth: string | null;
  enabled: boolean;
  purpose: string | null;
  /** ISO timestamp of the last probe, or null if never probed. */
  probedAt: string | null;
  /** Last-probed tool inventory (names + descriptions). */
  tools: McpToolInfo[];
}

export interface McpServersView {
  servers: McpServerView[];
}

export interface SkillEntry {
  name: string;
  description: string;
  /** 'authored' (self-written, trusted) or 'installed' (third-party). */
  trust: string;
  source: string | null;
}

export interface SkillsView {
  skills: SkillEntry[];
}

export interface SkillDetail {
  name: string;
  description: string;
  trust: string;
  source: string | null;
  /** The rendered SKILL.md body (markdown). */
  body: string;
  /** Dir-relative paths of every file in the skill (incl. SKILL.md). */
  files: string[];
}

export interface TurnUsage {
  in: number | null;
  out: number | null;
  cached: number | null;
  cacheWrite: number | null;
}

export interface MessageAttachment {
  kind: 'image' | 'file' | 'video' | 'audio';
  mediaType: string;
  name: string;
  /** Authenticated dashboard media route, or an external URL. */
  src: string;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  timestamp: string;
  senderName: string | null;
  /** Delivered bubbles: the user's text, or each assistant `send_message`. */
  delivered: string[];
  /** Inline image attachments (inbound + outbound), served via the auth gate. */
  attachments: MessageAttachment[];
  /** Assistant's retained private scratch (never delivered); null for users. */
  scratch: string | null;
  delivery: string | null;
  /** Whether this turn required the delivery-recovery backstop ("de-poisoning") —
   *  the same signal as the Activity "Backstop" column; drives the [R] marker. */
  recovered: boolean;
  steps: number | null;
  usage: TurnUsage | null;
  /** Full per-step trajectory (assistant turns only): the stored UIMessage parts,
   *  redacted. Rendered with the same `<MessageParts>` used for the live stream so
   *  historical turns keep the expanded display. Null for user messages. */
  parts: UIPart[] | null;
}

export interface ThreadSummary {
  threadId: string;
  label: string;
  /** All distinct human participants in the thread (stable, not just the last sender). */
  participants: string[];
  /** Channel the thread lives on (e.g. "imessage", "loopback"). */
  channel: string;
  isGroup: boolean;
  lastAt: string;
  count: number;
  preview: string;
}

export interface SearchHit {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  timestamp: string;
  senderName: string | null;
  text: string;
}

export interface JobRunView {
  id: string;
  /** Humanized run name: 'Background job' | 'Scheduled job' | raw function. */
  kind: string;
  name: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  stepCount: number;
  failedSteps: number;
}

export interface JobsView {
  jobs: JobRunView[];
}

export interface ScheduleRunView {
  id: string;
  firedAt: string;
  status: string;
  output: string | null;
  error: string | null;
}

export interface ScheduleView {
  id: string;
  kind: string;
  spec: string;
  label: string | null;
  prompt: string;
  threadId: string;
  timezone: string;
  active: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runs: ScheduleRunView[];
}

export interface ActivityTurn {
  id: string;
  threadId: string;
  timestamp: string;
  model: string | null;
  delivery: string | null;
  /** Whether the delivery-recovery backstop fired this turn (D-MG8). */
  recovered: boolean;
  steps: number | null;
  usage: TurnUsage | null;
}

export interface HealthComponent {
  ok: boolean;
  detail: string;
}

export interface Health {
  service: HealthComponent;
  database: HealthComponent;
  scheduler: HealthComponent;
  gateway: HealthComponent;
  unprocessedInbound: number;
  generatedAt: string;
}

// Live observability (live-conversation-streaming). A `LiveRun` is the unified
// descriptor for an in-flight turn or job, mirrored from the server's
// src/observability/live.ts. The live UIMessage itself is folded client-side from
// the SSE chunk stream using the AI SDK's `readUIMessageStream` (see components/live.ts).

export type RunKind = 'turn' | 'job';

export interface LiveRun {
  runId: string;
  kind: RunKind;
  threadId: string | null;
  label: string;
  status: 'running' | 'finished' | 'errored';
  startedAt: string;
  steps: number;
  model: string | null;
  effort: string | null;
  usage: TurnUsage | null;
  traceUrl: string | null;
}

export interface ActiveRunsView {
  runs: LiveRun[];
}

export type AuthState =
  | { state: 'authenticated' }
  | { state: 'open' } // dev-open (DASHBOARD_DEV_OPEN=1): no gate
  | { state: 'unconfigured' } // no session secret set: dashboard disabled
  | { state: 'anonymous' }
  | { state: 'pending'; requestId: string; deviceHint: string };
