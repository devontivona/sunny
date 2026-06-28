import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from '../src/gateway/store.js';
import {
  DelegationSupervisor,
  type ChildRunHandle,
} from '../src/agent/delegationSupervisor.js';
import {
  MAX_CONCURRENT_CHILDREN,
  createLink,
  getLinkByChildThread,
} from '../src/agent/delegation.js';
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
    const res = await sup.spawn({ parentThreadId: PARENT, task: 'research X', depth: 1, label: 'r' });

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
    const res = await sup.spawn({ parentThreadId: PARENT, task: 'one too many', depth: 1 });
    expect(res).toEqual({ error: 'concurrency_cap' });
    expect(startSubagent).not.toHaveBeenCalled();
  });

  it('refuses past the depth cap', async () => {
    const { sup, startSubagent } = makeSupervisor(Promise.resolve());
    const res = await sup.spawn({ parentThreadId: PARENT, task: 'too deep', depth: 99 });
    expect(res).toEqual({ error: 'depth_cap' });
    expect(startSubagent).not.toHaveBeenCalled();
  });

  it('watchdog: a child that dies has its link failed + a failure event sent to the parent', async () => {
    const wake = vi.fn();
    const { sup } = makeSupervisor(Promise.reject(new Error('child exploded')), wake);
    const res = await sup.spawn({ parentThreadId: PARENT, task: 'risky', depth: 1, label: 'risky' });
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
