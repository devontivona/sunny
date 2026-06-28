/**
 * Output target — the unifying "who am I talking to" routing knob for every durable run
 * (durable-subagents D-DS1 / D-DS14). It is INVISIBLE at the tool surface: `send_message`
 * carries no target argument; this config resolves to a transport + destination. Node-free,
 * so workflow code can import it (matches `bashSpecs`/`memorySpecs`).
 *
 *  - user   → deliver to the owner via the messaging gateway (today's job/schedule default)
 *  - parent → deliver to the spawning run's inbox thread (delegate-and-await; D-DS4)
 *  - silent → no proactive output; the run records its result but messages no one (the 2am fix)
 */
export type OutputTarget = 'user' | 'parent' | 'silent';

/**
 * How the shared finalize recovers when the agent produced text but never called `send_message`
 * (D-DS14 — "deliver" is the backstop branch of one emit path):
 *  - model   → conversation: rewrite private scratch into a clean message (the recovery pass)
 *  - rawtext → job/scheduled: the final assistant text IS the deliverable; emit it as-is
 *  - none    → silent: emit nothing
 */
export type RecoverOnMiss = 'model' | 'rawtext' | 'none';

export const ALL_OUTPUT_TARGETS: readonly OutputTarget[] = ['user', 'parent', 'silent'];

export function isOutputTarget(v: unknown): v is OutputTarget {
  return v === 'user' || v === 'parent' || v === 'silent';
}

/** Normalize a possibly-absent/legacy value to a concrete target (default `user`). */
export function outputTargetOr(v: unknown, fallback: OutputTarget = 'user'): OutputTarget {
  return isOutputTarget(v) ? v : fallback;
}

/**
 * Where an emitted message goes, resolved from `output_target` (D-DS12: inbox ⟂ output_target).
 * `destThreadId` is the OWNER thread for `user` and the PARENT's inbox thread for `parent`;
 * `from*` identify the sender so a `parent` report folds with a name prefix in the recipient's
 * `loadSteers` (the child is just another named sender).
 */
export interface EmitTarget {
  target: OutputTarget;
  destThreadId: string;
  fromId?: string;
  fromName?: string;
}
