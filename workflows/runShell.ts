import type { EmitTarget } from '../src/agent/outputTarget.js';

/**
 * Shared durable-run shell pieces (durable-subagents D-DS11/D-DS14). The conversational turn,
 * background job, scheduled job, and delegated child are the SAME `WorkflowAgent` shell differing
 * only in config; the genuinely shared mechanism lives here so the per-trigger workflow entrypoints
 * (`conversation.ts`, `job.ts`, `scheduledJob.ts`, `subagent.ts`) stay thin and can never drift on
 * the outward-emit path. Node-free at module scope (steps dynamic-import runtime modules), matching
 * the rest of the workflow code.
 */

/**
 * The single outward primitive (D-DS14): emit `text`, routed by `output_target`. BOTH the
 * `send_message` tool's `execute` AND the finalize backstop (a job's terminal "deliver") call
 * this — there is no separate `deliver`. Memoized as a `'use step'`, so a replayed run never
 * re-emits.
 *  - silent → nothing (the run still records its result elsewhere; see each profile's finalize)
 *  - user   → `gateway.send(destThreadId)` (owner via the messaging gateway)
 *  - parent → append the message to the parent run's inbox thread as a steer its next run folds
 *             via `loadSteers`, then wake the parent's run-supply (the supervisor) — D-DS4.
 */
export async function emitStep(out: EmitTarget, text: string): Promise<void> {
  'use step';

  if (out.target === 'silent' || !text) return;

  const { getRuntime } = await import('../src/runtime.js');
  const runtime = await getRuntime();

  if (out.target === 'parent') {
    // Delegated child → parent: append to the parent's inbox thread + wake its run-supply.
    // Wired with the delegation supervisor in a later task; until then this path is unused
    // (only `delegate_task` children set `parent`, which doesn't exist yet).
    const { reportToParent } = await import('../src/agent/delegation.js');
    await reportToParent(runtime, out, text);
    return;
  }

  // user (the default): deliver to the owner thread via the gateway.
  await runtime.gateway.send(out.destThreadId, { text });
}
