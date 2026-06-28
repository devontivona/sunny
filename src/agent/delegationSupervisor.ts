import type { Db } from '../db/client.js';
import type { ConversationStore } from '../gateway/store.js';
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
}

export type SpawnResult =
  | { childThreadId: string; childRunId: string }
  | { error: 'depth_cap' | 'concurrency_cap' };

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

  /** Spawn a child for `parentThreadId`, enforcing caps. Returns the child's handle immediately
   *  (non-blocking, D-DS2); the watchdog runs in the background. */
  async spawn(input: SpawnInput): Promise<SpawnResult> {
    if (input.depth > MAX_DELEGATION_DEPTH) {
      log.warn('delegation refused: depth cap', { depth: input.depth, parent: input.parentThreadId });
      return { error: 'depth_cap' };
    }
    const active = await activeChildCount(this.db, input.parentThreadId);
    if (active >= MAX_CONCURRENT_CHILDREN) {
      log.warn('delegation refused: concurrency cap', { active, parent: input.parentThreadId });
      return { error: 'concurrency_cap' };
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

    const run = await this.startSubagent({
      childThreadId,
      parentThreadId: input.parentThreadId,
      task: input.task,
      toolset: input.toolset,
      model: input.model,
      label: input.label,
    });
    await setChildRunId(this.db, childThreadId, run.runId);
    log.info('child spawned', { childThreadId, runId: run.runId, parent: input.parentThreadId });

    // Watchdog (D-DS6): fire-and-forget — observe terminal failure the child can't report itself.
    void this.watch(childThreadId, input.parentThreadId, input.label ?? 'subagent', run.returnValue);

    return { childThreadId, childRunId: run.runId };
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
