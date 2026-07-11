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
