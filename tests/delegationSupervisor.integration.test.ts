import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from '../src/gateway/store.js';
import { DelegationSupervisor, type ChildRunHandle } from '../src/agent/delegationSupervisor.js';
import {
  MAX_CONCURRENT_CHILDREN,
  activeChildCount,
  completeLink,
  createLink,
  getLinkByChildThread,
} from '../src/agent/delegation.js';
import { TRUSTED_DM_AUTHORITY } from '../src/agent/audience.js';
import { createTestDb, type TestDb } from './db.js';

/**
 * Delegation supervisor (durable-subagents D-DS6/D-DS8/D-DS13) against the real link store
 * (PGlite). Verifies the fan-out/depth caps, link creation, and the WATCHDOG: a child whose
 * run rejects has its link marked failed and a failure event delivered to the parent's inbox —
 * since a dead child can't report for itself.
 */
describe('DelegationSupervisor', () => {
  let tdb: TestDb;
  let store: ConversationStore;
  const PARENT = 'imessage:owner';

  beforeEach(async () => {
    tdb = await createTestDb();
    store = new ConversationStore(tdb.db, 30);
  });
  afterEach(async () => {
    await tdb.teardown();
  });

  /** A supervisor whose child-start is faked with a controllable returnValue. */
  function makeSupervisor(returnValue: Promise<unknown>, wake = vi.fn()) {
    const startSubagent = vi.fn(
      async (): Promise<ChildRunHandle> => ({ runId: 'run-x', returnValue }),
    );
    const sup = new DelegationSupervisor(tdb.db, store, startSubagent, wake);
    return { sup, startSubagent, wake };
  }

  it('spawns under the caps: creates a link, starts the child, returns its id', async () => {
    const { sup, startSubagent } = makeSupervisor(Promise.resolve());
    const res = await sup.spawn({
      parentThreadId: PARENT,
      task: 'research X',
      depth: 1,
      label: 'r',
      parentAuthority: TRUSTED_DM_AUTHORITY,
    });

    expect('childThreadId' in res).toBe(true);
    if (!('childThreadId' in res)) return;
    expect(startSubagent).toHaveBeenCalledOnce();
    const link = await getLinkByChildThread(tdb.db, res.childThreadId);
    expect(link?.status).toBe('running');
    expect(link?.childRunId).toBe('run-x');
    expect(link?.parentThreadId).toBe(PARENT);
  });

  it('refuses past the concurrency cap', async () => {
    // Pre-seed MAX running children for this parent.
    for (let i = 0; i < MAX_CONCURRENT_CHILDREN; i++) {
      await createLink(tdb.db, {
        parentThreadId: PARENT,
        childThreadId: `subagent:pre-${i}`,
        task: 't',
        depth: 1,
        orchestrator: false,
      });
    }
    const { sup, startSubagent } = makeSupervisor(Promise.resolve());
    const res = await sup.spawn({
      parentThreadId: PARENT,
      task: 'one too many',
      depth: 1,
      parentAuthority: TRUSTED_DM_AUTHORITY,
    });
    expect(res).toEqual({ error: 'concurrency_cap' });
    expect(startSubagent).not.toHaveBeenCalled();
  });

  it('refuses past the depth cap', async () => {
    const { sup, startSubagent } = makeSupervisor(Promise.resolve());
    const res = await sup.spawn({
      parentThreadId: PARENT,
      task: 'too deep',
      depth: 99,
      parentAuthority: TRUSTED_DM_AUTHORITY,
    });
    expect(res).toEqual({ error: 'depth_cap' });
    expect(startSubagent).not.toHaveBeenCalled();
  });

  it('completeLink only transitions a running link — a cancelled link is never overwritten', async () => {
    // cancel_run marks a running child 'cancelled'; when the still-running child later finishes,
    // its closeLink('done') must NOT resurrect it (nor a late watchdog 'failed'), so the
    // cancellation stays recorded and Sunny's "it will stop reporting" is honest.
    await createLink(tdb.db, {
      parentThreadId: PARENT,
      childThreadId: 'subagent:cancelme',
      task: 't',
      depth: 1,
      orchestrator: false,
    });
    await completeLink(tdb.db, 'subagent:cancelme', 'cancelled'); // cancel_run
    await completeLink(tdb.db, 'subagent:cancelme', 'done'); // child finishes afterward
    await completeLink(tdb.db, 'subagent:cancelme', 'failed'); // late watchdog fire
    expect((await getLinkByChildThread(tdb.db, 'subagent:cancelme'))?.status).toBe('cancelled');
  });

  it('refuses a child whose authority exceeds the parent (monotone attenuation, D-RA5)', async () => {
    // A restricted (readonly) parent cannot mint a `host` child — that would BROADEN authority.
    const { sup, startSubagent } = makeSupervisor(Promise.resolve());
    const res = await sup.spawn({
      parentThreadId: PARENT,
      task: 'escalate',
      depth: 1,
      toolset: 'host',
      parentAuthority: ['file_read'], // a readonly orchestrator's authority
    });
    expect(res).toEqual({ error: 'authority' });
    expect(startSubagent).not.toHaveBeenCalled();
  });

  it('a startSubagent failure frees the concurrency slot instead of leaking a running link (DelegSpawn)', async () => {
    // createLink records a `running` link (a concurrency slot) BEFORE the child is started. If
    // startSubagent then throws, without compensation that link leaks as `running` with a null
    // childRunId — permanently consuming one of the parent's 3 slots. The fix marks it failed.
    const startSubagent = vi.fn(async (): Promise<ChildRunHandle> => {
      throw new Error('spawn boom');
    });
    const sup = new DelegationSupervisor(tdb.db, store, startSubagent, vi.fn());
    await expect(
      sup.spawn({
        parentThreadId: PARENT,
        task: 't',
        depth: 1,
        parentAuthority: TRUSTED_DM_AUTHORITY,
      }),
    ).rejects.toThrow('spawn boom');

    // The slot is freed: no running link for this parent.
    expect(await activeChildCount(tdb.db, PARENT)).toBe(0);
  });

  it('a setChildRunId failure after the child is live does not re-throw (no step-retry duplicate, DelegSpawn)', async () => {
    // doSpawn runs inside a durable `'use step'`; a throw retries the WHOLE step, re-running
    // startSubagent and spawning a DUPLICATE live child. So once the child is live, recording its
    // run id is best-effort — a failure there must be swallowed, not re-thrown.
    const startSubagent = vi.fn(
      async (): Promise<ChildRunHandle> => ({ runId: 'run-x', returnValue: Promise.resolve() }),
    );
    const sup = new DelegationSupervisor(tdb.db, store, startSubagent, vi.fn());
    // The only `db.update` in the success path is setChildRunId — make it throw once.
    vi.spyOn(tdb.db, 'update').mockImplementationOnce(() => {
      throw new Error('setChildRunId boom');
    });

    const res = await sup.spawn({
      parentThreadId: PARENT,
      task: 't',
      depth: 1,
      parentAuthority: TRUSTED_DM_AUTHORITY,
    });

    // Resolved (did not throw → the step won't retry → no duplicate child) and started exactly once.
    expect('childThreadId' in res).toBe(true);
    expect(startSubagent).toHaveBeenCalledOnce();
    if (!('childThreadId' in res)) return;
    // The child is live; its link stays running (a null childRunId is the recoverable gap the
    // restart re-attach already tolerates).
    const link = await getLinkByChildThread(tdb.db, res.childThreadId);
    expect(link?.status).toBe('running');
  });

  it('watchdog: a child that dies has its link failed + a failure event sent to the parent', async () => {
    const wake = vi.fn();
    const { sup } = makeSupervisor(Promise.reject(new Error('child exploded')), wake);
    const res = await sup.spawn({
      parentThreadId: PARENT,
      task: 'risky',
      depth: 1,
      label: 'risky',
      parentAuthority: TRUSTED_DM_AUTHORITY,
    });
    expect('childThreadId' in res).toBe(true);
    if (!('childThreadId' in res)) return;

    // The watchdog runs in the background; wait for it to mark the link failed.
    await vi.waitFor(async () => {
      const link = await getLinkByChildThread(tdb.db, res.childThreadId);
      expect(link?.status).toBe('failed');
    });

    // A failure event reached the parent's inbox (so the parent's next turn learns of it).
    const window = await store.recentWindow(PARENT);
    const failure = window.find((m) => m.role === 'user' && m.text.includes('failed'));
    expect(failure).toBeTruthy();
    expect(wake).toHaveBeenCalledWith(PARENT);
  });
});
