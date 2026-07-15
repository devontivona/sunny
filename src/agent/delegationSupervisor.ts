import type { Db } from '../db/client.js';
import type { ConversationStore } from '../gateway/store.js';
import { runSerial } from '../gateway/serial.js';
import { type Authority, attenuate, authorityForToolset } from './audience.js';
import type { SubagentInput, ChildToolset } from '../../workflows/subagent.js';
import {
  MAX_CONCURRENT_CHILDREN,
  MAX_DELEGATION_DEPTH,
  activeChildCount,
  appendInterRunMessage,
  completeLink,
  createLink,
  getLinkByChildThread,
  newChildThreadId,
  reportToParent,
  setChildRunId,
} from './delegation.js';
import { SUBAGENT_MAX_RUNTIME_MS } from './limits.js';
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
  /** The spawning run's authority (run-audiences D-RA5). The child's preset grants are
   *  ATTENUATED against it here at spawn (intersection — no ambient authority): a preset asks
   *  for its full bundle and receives what the parent can actually endow. */
  parentAuthority: Authority;
  /** Whether the spawning context may edit the owner-core files; inherited by the child. */
  ownerScope?: boolean;
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
    /** Cancel a child's WDK run by id (the wall-clock cap's teeth) + the cap itself.
     *  Injected like `startSubagent` so the supervisor stays unit-testable without the WDK. */
    private readonly runControl?: {
      cancelRun: (runId: string) => Promise<void>;
      maxRuntimeMs?: number;
    },
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
    // Monotone attenuation (D-RA5): the child's grants are the preset's bundle INTERSECTED with
    // the parent's authority — a preset is a convenience request, not a named demand, so a host
    // child of a family DM simply comes up without the owner-facing registries instead of being
    // refused. (Explicit grant requests — schedule_create's `authority` — use subset+refusal.)
    const childAuthority = attenuate(authorityForToolset(input.toolset), input.parentAuthority);

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
        authority: childAuthority,
        ownerScope: input.ownerScope ?? false,
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
      run.runId,
      Date.now(),
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
    runId?: string,
    startedAtMs?: number,
  ): void {
    void this.watch(childThreadId, parentThreadId, label, returnValue, runId, startedAtMs);
  }

  /**
   * Await the child's completion; on terminal failure, deliver a failure event to the parent.
   * Wall-clock cap (subagent-hardening): a child that is still running at `maxRuntimeMs` gets
   * its WDK run CANCELLED — the failure mode this catches is a run that never finishes without
   * burning budget (a hung stream, an endless wait), which the in-loop dollar budget can't see.
   * `startedAtMs` anchors the cap across restarts (reattach passes the link's createdAt).
   */
  private async watch(
    childThreadId: string,
    parentThreadId: string,
    label: string,
    returnValue: Promise<unknown>,
    runId?: string,
    startedAtMs?: number,
  ): Promise<void> {
    const capMs = this.runControl?.maxRuntimeMs ?? SUBAGENT_MAX_RUNTIME_MS;
    const remainingMs = Math.max(60_000, capMs - (Date.now() - (startedAtMs ?? Date.now())));
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<'cap'>((resolve) => {
      timer = setTimeout(() => resolve('cap'), remainingMs);
      timer.unref?.();
    });
    const settled = returnValue.then(
      () => ({ kind: 'done' as const }),
      (err: unknown) => ({ kind: 'failed' as const, err }),
    );
    const outcome =
      this.runControl?.cancelRun && runId ? await Promise.race([settled, cap]) : await settled;
    clearTimeout(timer);

    if (outcome === 'cap') {
      log.error('child exceeded max runtime — cancelling', { childThreadId, runId, capMs });
      // Link first (same ordering as cancel_run): the cancel makes returnValue reject, and the
      // failure branch below must find the link already terminal so it stays silent.
      await completeLink(this.db, childThreadId, 'timeout').catch(() => {});
      await this.runControl!.cancelRun(runId!).catch((err) => {
        log.error('child run cancel failed', { childThreadId, runId, err: String(err) });
      });
      settled.catch(() => {}); // defuse: the raced promise settles later, unobserved
      // Through the one report seam (voice-layer invariant): attribution + wake are
      // reportToParent's job — the supervisor never hand-formats the worker label.
      await reportToParent(
        { store: this.store, wakeThread: this.wake },
        { threadId: parentThreadId, fromId: 'watchdog', fromName: label },
        `[exceeded the ${Math.round(capMs / 60_000)}-minute runtime cap and was cancelled ` +
          `before it could report]`,
      ).catch(() => {});
      return;
    }

    if (outcome.kind === 'done') return; // the child closes its own link (D-DS7)

    // A run whose link is ALREADY terminal died on purpose (cancel_run / the cap above set it
    // before cancelling) — the parent was told by whoever cancelled; a failure report here
    // would be a spurious second death notice.
    const link = await getLinkByChildThread(this.db, childThreadId).catch(() => undefined);
    if (link && link.status !== 'running') {
      log.info('child ended after its link closed (intentional cancel)', { childThreadId });
      return;
    }
    log.error('child failed', { childThreadId, err: String(outcome.err) });
    await completeLink(this.db, childThreadId, 'failed').catch(() => {});
    await reportToParent(
      { store: this.store, wakeThread: this.wake },
      { threadId: parentThreadId, fromId: 'watchdog', fromName: label },
      `[failed before it could report: ${truncate(String(outcome.err))}]`,
    ).catch(() => {});
  }
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export { MAX_CONCURRENT_CHILDREN, MAX_DELEGATION_DEPTH };
