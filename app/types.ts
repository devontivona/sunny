// JSON shapes returned by the dashboard's read-only API (src/dashboard/api/*).
// Kept in sync by hand with the server transforms — the app and server build
// under different tsconfigs, so they don't share a module.

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

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  timestamp: string;
  senderName: string | null;
  /** Delivered bubbles: the user's text, or each assistant `send_message`. */
  delivered: string[];
  /** Assistant's retained private scratch (never delivered); null for users. */
  scratch: string | null;
  delivery: string | null;
  steps: number | null;
  usage: TurnUsage | null;
}

export interface ThreadSummary {
  threadId: string;
  label: string;
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

export type AuthState =
  | { state: 'authenticated' }
  | { state: 'open' } // dev-open (DASHBOARD_DEV_OPEN=1): no gate
  | { state: 'unconfigured' } // no session secret set: dashboard disabled
  | { state: 'anonymous' }
  | { state: 'pending'; requestId: string; deviceHint: string };
