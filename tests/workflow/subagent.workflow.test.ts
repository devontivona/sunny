import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { start } from 'workflow/api';
import { runSubagent } from '../../workflows/subagent.js';
import { createLink, getLinkByChildThread } from '../../src/agent/delegation.js';
import { subagentLinks } from '../../src/db/schema.js';
import {
  setTurnModel,
  setupTestRuntime,
  teardownTestRuntime,
  type TestRuntimeCtx,
} from './harness.js';

/**
 * `runSubagent` against a real in-process WDK Local World (durable-subagents tasks 5/6).
 * The core child→parent slice: a delegated child runs in isolation, reports to its PARENT's
 * inbox thread via the shared `emitStep` (output_target=parent), and closes its link
 * (run-to-completion, D-DS7). Proves the parent↔child channel is just a store write the
 * parent's next run would fold via `loadSteers` — no hook.
 */
describe('runSubagent (workflow integration — real Local World)', () => {
  let ctx: TestRuntimeCtx;
  afterEach(async () => {
    if (ctx) await teardownTestRuntime(ctx);
  });

  const PARENT = 'imessage:owner';
  const CHILD = 'subagent:test-1';

  it('reports its result to the parent inbox and closes its link', async () => {
    ctx = await setupTestRuntime();
    await createLink(ctx.db.db, {
      parentThreadId: PARENT,
      childThreadId: CHILD,
      task: 'find 3 sources on X',
      depth: 1,
      orchestrator: false,
    });
    // Child produces a final text result (no send_message) → terminal rawtext report to parent.
    setTurnModel([{ type: 'text', text: 'found 3 sources: A, B, C' }]);

    const run = await start(runSubagent, [
      { childThreadId: CHILD, parentThreadId: PARENT, task: 'find 3 sources on X', label: 'researcher' },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // The report landed on the PARENT's inbox thread as an unanswered inbound the parent would fold.
    const window = await ctx.store.recentWindow(PARENT);
    const report = window.find((m) => m.role === 'user' && m.text.includes('found 3 sources'));
    expect(report).toBeTruthy();
    expect(report?.senderName).toBe('researcher');
    expect(await ctx.store.hasUnansweredInbound(PARENT)).toBe(true); // would wake a parent turn

    // The link is closed (run-to-completion, D-DS7).
    const link = await getLinkByChildThread(ctx.db.db, CHILD);
    expect(link?.status).toBe('done');
  });

  it('when the child reports via send_message, the parent gets exactly that (no double-emit)', async () => {
    ctx = await setupTestRuntime();
    await createLink(ctx.db.db, {
      parentThreadId: PARENT,
      childThreadId: 'subagent:test-2',
      task: 'summarize',
      depth: 1,
      orchestrator: false,
    });
    // Child calls send_message (its report tool), then stops — terminal rawtext must NOT also fire.
    setTurnModel([
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'summary: done' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runSubagent, [
      { childThreadId: 'subagent:test-2', parentThreadId: PARENT, task: 'summarize', label: 'summarizer' },
    ]);
    await run.returnValue;

    const reports = (await ctx.store.recentWindow(PARENT)).filter(
      (m) => m.role === 'user' && m.senderName === 'summarizer',
    );
    expect(reports).toHaveLength(1); // exactly one — the tool send, not also a terminal rawtext
    expect(reports[0]?.text).toContain('summary: done');
    expect(reports[0]?.text).toContain('summarizer'); // attributed so the parent knows the sender
    const [link] = await ctx.db.db
      .select()
      .from(subagentLinks)
      .where(eq(subagentLinks.childThreadId, 'subagent:test-2'));
    expect(link?.status).toBe('done');
  });
});
