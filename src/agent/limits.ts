/**
 * Agent step backstop. The model loops until it stops calling tools on its own
 * (the natural end of a turn/job); this is only a runaway guard so a stuck loop
 * can't spin forever and burn unbounded tokens — NOT a cap on legitimate work.
 * Set high enough that real multi-step work (e.g. building + hosting a site) never
 * hits it. A previous 20-step cap was cutting off real builds mid-flight.
 *
 * Pure constant (no imports) so it is safe to import from workflow/sandbox code.
 */
export const AGENT_STEP_LIMIT = 1000;

/** Bounded fan-out + depth (D-DS8): defaults guarded against the "depth 5 × branching 3 = 243
 *  agents" blowup. A child cannot delegate further unless it is an orchestrator. Pure constants
 *  here (not delegation.ts) so workflow code can quote the cap without dragging in db/runtime. */
export const MAX_CONCURRENT_CHILDREN = 5;
export const MAX_DELEGATION_DEPTH = 2;

/**
 * Delegated-child spend ceiling (subagent-hardening, 2026-07-12). A child run may never spend
 * more than this many dollars of model usage, caching included. Enforced in the agent loop
 * from per-step usage: at SOFT_FRACTION a wrap-up notice is folded into the prompt (the child
 * is told to stop working and report), at 1.0 the loop stops. The 2026-07-12 marathon burned
 * ~$171 without either; a healthy sibling shipped a PR for ~$14.
 */
export const SUBAGENT_BUDGET_USD = 50;
export const SUBAGENT_BUDGET_SOFT_FRACTION = 0.9;

/** Child step backstop — secondary to the dollar budget (~$50 ≈ 400 steps at the measured
 *  child profile with caching working). The conversation keeps AGENT_STEP_LIMIT. */
export const SUBAGENT_STEP_LIMIT = 400;

/**
 * Child wall-clock cap (supervisor-enforced): catches a run that is NOT burning budget but
 * never finishes — a hung stream, an infinite wait — which the dollar budget can't see.
 * Generous: a budget-bound run at the measured cadence (~1 generation/min) ends well before it.
 */
export const SUBAGENT_MAX_RUNTIME_MS = 4 * 60 * 60 * 1000;

/**
 * Dollar rates for the child budget meter, per MILLION tokens (claude-sonnet-5 intro pricing,
 * through 2026-08-31; revisit if DEFAULT_CHILD_MODEL changes). When a step's usage lacks the
 * input split, the meter prices ALL its input at the cache-write rate — on a hard budget,
 * overcounting beats undercounting.
 */
export const SUBAGENT_TOKEN_RATES_USD_PER_MTOK = {
  input: 2,
  cacheRead: 0.2,
  cacheWrite: 2.5,
  output: 10,
} as const;
