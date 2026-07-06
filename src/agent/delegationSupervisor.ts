import type { Db } from '../db/client.js';
import type { ConversationStore } from '../gateway/store.js';
import { runSerial } from '../gateway/serial.js';
import { type Authority, authorityForToolset, isAuthoritySubset } from './audience.js';
import type { SubagentInput, ChildToolset } from '../../workflows/subagent.js';
import {
  MAX_CONCURRENT_CHILDREN,
  MAX_DELEGATION_DEPTH,
  activeChildCount,
  appendInterRunMessage,
  completeLink,
  createLink,
  newChildThreadId,
  setChildRunId,
} from './delegation.js';
import { logger } from '../logger.js';

const log = logger('delegation-supervisor');

/** A started child run handle (the subset of the WDK `Run` the supervisor needs). */
export interface ChildRunHandle {
  runId: string;
  returnValue: Promise<unknown>;
}

export interface SpawnInput {
  parentThreadId: string;
  task: string;
  toolset?: ChildToolset;
  model?: string;
  label?: string;
  orchestrator?: boolean;
  /** Spawn depth: a top-level (Sunny) delegation is depth 1; an orchestrator child's children 2… */
  depth: number;
  /** The spawning run's authority (run-audiences D-RA5). The child's toolset grants MUST be a
   *  subset — monotone attenuation, enforced here at spawn (no ambient authority). */
  parentAuthority: Authority;
}

export type SpawnResult =
  | { childThreadId: string; childRunId: string }
  | { error: 'depth_cap' | 'concurrency_cap' | 'authority' };

/**
 * The delegation supervisor (durable-subagents D-DS13/D-DS6) — the run-supply engine for
 * single-run children, the sibling of `DurableTurnRouter`'s perpetual run-supply for the owner
 * conversation. It enforces the fan-out/depth caps (D-DS8), starts the child run, records the
 * durable link, and — the watchdog (D-DS6) — `await`s the child's `returnValue`: a child that
 * dies terminally cannot report for itself, so the supervisor's catch branch delivers a failure
 * event to the parent's inbox and wakes it. `startSubagent` + `wake` are injected so the
 * supervisor is unit-testable without the WDK or the live router.
 */
export class DelegationSupervisor {
  constructor(
    private readonly db: Db,
    private readonly store: ConversationStore,
    private readonly startSubagent: (input: SubagentInput) => Promise<ChildRunHandle>,
    private readonly wake: (threadId: string) => void,
  ) {}

  /** Per-parent serial chains: makes each parent's cap-check → createLink atomic in-process. */
  private readonly spawnChain = new Map<string, Promise<unknown>>();

  /** Spawn a child for `parentThreadId`, enforcing caps. Returns the child's handle immediately
   *  (non-blocking, D-DS2); the watchdog runs in the background. The whole cap-check → createLink
   *  is serialized PER PARENT (`runSerial`) so two `delegate_task` tool calls in the same model
   *  step — whose `execute`s the AI SDK runs concurrently — can't both pass the gate and exceed
   *  the cap (the check-then-insert would otherwise be a TOCTOU race). One in-process supervisor,
   *  so a per-parent serial chain fully closes it. */
  spawn(input: SpawnInput): Promise<SpawnResult> {
    return runSerial(this.spawnChain, input.parentThreadId, () => this.doSpawn(input));
  }

  private async doSpawn(input: SpawnInput): Promise<SpawnResult> {
    if (input.depth > MAX_DELEGATION_DEPTH) {
      log.warn('delegation refused: depth cap', {
        depth: input.depth,
        parent: input.parentThreadId,
      });
      return { error: 'depth_cap' };
    }
    const active = await activeChildCount(this.db, input.parentThreadId);
    if (active >= MAX_CONCURRENT_CHILDREN) {
      log.warn('delegation refused: concurrency cap', { active, parent: input.parentThreadId });
      return { error: 'concurrency_cap' };
    }
    // Monotone attenuation (D-RA5): the child's toolset may not grant authority the parent lacks.
    // Structurally always true for a top-level delegation (delegation is trusted-DM-only, and the
    // parent holds the full set); it bites a future orchestrator whose grandchild asks for more.
    const childAuthority = authorityForToolset(input.toolset);
    if (!isAuthoritySubset(childAuthority, input.parentAuthority)) {
      log.warn('delegation refused: authority not a subset of parent', {
        child: childAuthority,
        parent: input.parentAuthority,
      });
      return { error: 'authority' };
    }

    const childThreadId = newChildThreadId();
    await createLink(this.db, {
      parentThreadId: input.parentThreadId,
      childThreadId,
      task: input.task,
      depth: input.depth,
      orchestrator: input.orchestrator ?? false,
      model: input.model,
    });

    // The link now holds a concurrency slot (status 'running'). If starting the child throws, that
    // slot leaks forever (a running link with a null childRunId) — so compensate: free it before
    // re-throwing. delegateStep runs inside a durable `'use step'`, so a throw here retries the
    // whole spawn; freeing the slot keeps the retry from piling up leaked links (DelegSpawn).
    let run: ChildRunHandle;
    try {
      run = await this.startSubagent({
        childThreadId,
        parentThreadId: input.parentThreadId,
        task: input.task,
        toolset: input.toolset,
        model: input.model,
        label: input.label,
      });
    } catch (err) {
      await completeLink(this.db, childThreadId, 'failed').catch(() => {});
      throw err;
    }

    // The child is now LIVE. From here doSpawn must NOT throw: a throw would retry the durable step
    // and spawn a DUPLICATE live child for the same task (DelegSpawn). Recording the run id is
    // therefore best-effort — a null childRunId is the same recoverable gap the restart re-attach
    // already tolerates (it frees that slot), and the in-process watchdog observes the live handle
    // regardless. So swallow a setChildRunId failure rather than let it trigger a re-spawn.
    await setChildRunId(this.db, childThreadId, run.runId).catch((err) => {
      log.error('setChildRunId failed (continuing; child is live)', {
        childThreadId,
        err: String(err),
      });
    });
    log.info('child spawned', { childThreadId, runId: run.runId, parent: input.parentThreadId });

    // Watchdog (D-DS6): fire-and-forget — observe terminal failure the child can't report itself.
    void this.watch(
      childThreadId,
      input.parentThreadId,
      input.label ?? 'subagent',
      run.returnValue,
    );

    return { childThreadId, childRunId: run.runId };
  }

  /**
   * Re-arm the watchdog for an already-running child after a process restart (D-DS6). The
   * in-memory `watch` is the only thing observing a child's `returnValue`, so without this a child
   * in flight across a restart whose run later fails would leak a `running` link forever (a
   * permanently-consumed concurrency slot) and never report its failure. Runtime startup enumerates
   * the durable `running` links and calls this with a re-subscribed `returnValue`.
   */
  reattach(
    childThreadId: string,
    parentThreadId: string,
    label: string,
    returnValue: Promise<unknown>,
  ): void {
    void this.watch(childThreadId, parentThreadId, label, returnValue);
  }

  /** Await the child's completion; on terminal failure, deliver a failure event to the parent. */
  private async watch(
    childThreadId: string,
    parentThreadId: string,
    label: string,
    returnValue: Promise<unknown>,
  ): Promise<void> {
    try {
      await returnValue;
      // Success: the child closes its own link (run-to-completion, D-DS7). Nothing to do.
    } catch (err) {
      log.error('child failed', { childThreadId, err: String(err) });
      await completeLink(this.db, childThreadId, 'failed').catch(() => {});
      await appendInterRunMessage(
        this.store,
        parentThreadId,
        { id: 'watchdog', name: label },
        `[delegated task "${label}" failed before it could report: ${truncate(String(err))}]`,
      ).catch(() => {});
      this.wake(parentThreadId);
    }
  }
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export { MAX_CONCURRENT_CHILDREN, MAX_DELEGATION_DEPTH };
