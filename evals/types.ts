import type { Delivery } from '../src/agent/turn.js';
import type { SunnyConfig } from '../src/config/index.js';
import type { MemoryWriteInput } from '../src/memory/index.js';

/** The behavioral dimensions the dataset covers (agent-evals spec). */
export type Dimension = 'elicitation' | 'memory' | 'tool-selection';

/** One tool call observed in the turn's trajectory (name + parsed input). */
export interface ToolCallRecord {
  name: string;
  input: unknown;
}

/**
 * The captured outcome of a turn — what graders read (design D7). Assembled from the persisted
 * D-MG9 turn parts (the turn's tool calls + the `delivered` classification) plus the fake
 * gateway's captured outbound. NOT database state.
 */
export interface Trajectory {
  /** Every tool call in the turn, in order (incl. `send_message`). */
  toolCalls: ToolCallRecord[];
  /** The user-facing bubbles delivered via `send_message` (or the fallback). */
  sends: string[];
  /** How the reply reached the user (D-MG8). */
  delivered: Delivery;
  /** Whether the delivery-recovery backstop fired to rescue a missed send (D-MG8). */
  recovered: boolean;
  /** The `start_job` tool calls the model elected to make (from the persisted turn parts). */
  startJobs: ToolCallRecord[];
  /** The user-facing reply text (sends joined) — the judge's `output`. */
  finalText: string;
  /** The private scratchpad text (never delivered). */
  scratch: string;
  /** Token usage of the turn under test (from the persisted D-MG9 metadata), for cost. */
  usage: TurnUsage;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** The verdict of one grader for one run. */
export interface GradeResult {
  name: string;
  pass: boolean;
  /** 0..1 — 1 for a passing programmatic grader; the judge's score otherwise. */
  score: number;
  rationale?: string;
}

/** A grader reads the trajectory (and the case) and returns a verdict. */
export type Grader = (t: Trajectory, c: EvalCase) => GradeResult | Promise<GradeResult>;

/** A prior message to seed before the turn under test. */
export interface ConversationSeed {
  role: 'user' | 'assistant';
  text: string;
  senderName?: string;
}

/** One REAL captured turn for a fixture-from-a-trace (built by `evals/capture-turn.ts`
 *  from the persisted Postgres rows). Seeded verbatim through the store so the loop
 *  reconstructs the EXACT production history a turn ran against. */
export interface FixtureTurn {
  role: 'user' | 'assistant';
  /** Flattened text projection (delivered/inbound text). */
  text: string;
  /** The rich `UIMessage` payload — for an assistant turn this carries the scratch +
   *  every tool part incl. `send_message`, seeded via `appendTurn` so history (and the
   *  send/scratch ratio that drives elicitation) reconstructs faithfully. */
  payload?: unknown;
}

export interface EvalCaseSetup {
  /** Seeded memory core, written through the REAL `applyMemoryWrite` (D15). */
  memory?: MemoryWriteInput[];
  /** Prior conversation, seeded through the REAL store APIs. */
  conversation?: ConversationSeed[];
  /** REAL captured turns (from `evals/capture-turn.ts`) seeded verbatim — assistant turns
   *  via `appendTurn` with their raw `UIMessage` payload — so the loop replays the exact
   *  production history. This is how a fixture-from-a-real-conversation drives the eval. */
  fixtureTurns?: FixtureTurn[];
  /** Snapshot of the real memory core (USER/SUNNY/INDEX) captured with the fixture, written
   *  to the eval runtime's memory files so `buildSystemPrompt` reconstructs the SAME system
   *  prompt production used. WITHOUT this the eval is ~half the prompt short (incl. SUNNY.md's
   *  behavior conventions) and elicitation rates are not production-representative. */
  memoryCore?: { user?: string; sunny?: string; index?: string };
  /** Config overrides (e.g. a small `recentWindowSize` to push an archive out of window). */
  config?: Partial<SunnyConfig>;
  isOwner?: boolean;
  isGroup?: boolean;
}

/**
 * A versioned eval case (task 7.2). Typed TS module (design D14): declares its
 * setup, input message(s), and the graders that judge it. Cases live as
 * reviewable files under `evals/cases/**`.
 */
export interface EvalCase {
  name: string;
  dimension: Dimension;
  setup?: EvalCaseSetup;
  /** The user message(s) for the turn(s) under test. */
  input: string | string[];
  graders: Grader[];
  /** Per-case pass-rate threshold (overrides the dimension/run default). */
  threshold?: number;
}
