import type { Delivery } from '../src/agent/turn.js';
import type { SunnyConfig } from '../src/config/index.js';
import type { MemoryWriteInput } from '../src/memory/index.js';
import type { RecordedStart } from '../tests/fakes/start.js';

/** The behavioral dimensions the dataset covers (agent-evals spec). */
export type Dimension = 'elicitation' | 'memory' | 'tool-selection';

/** One tool call observed in the turn's trajectory (name + parsed input). */
export interface ToolCallRecord {
  name: string;
  input: unknown;
}

/**
 * The captured outcome of a turn — what graders read (design D7). Assembled from
 * the loop's native outputs (the persisted D-MG9 turn parts = `result.steps`'
 * tool calls, the `delivered` classification) plus the fake gateway's captured
 * outbound and the recording fake `start`. NOT database state.
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
  /** Durable jobs the model elected to start (recorded, not launched). */
  startJobs: RecordedStart[];
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

export interface EvalCaseSetup {
  /** Seeded memory core, written through the REAL `applyMemoryWrite` (D15). */
  memory?: MemoryWriteInput[];
  /** Prior conversation, seeded through the REAL store APIs. */
  conversation?: ConversationSeed[];
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
