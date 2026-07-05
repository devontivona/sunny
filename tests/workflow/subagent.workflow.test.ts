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

  it('delivers a mid-task <report> block while continuing, without re-delivering it terminally', async () => {
    ctx = await setupTestRuntime();
    await createLink(ctx.db.db, {
      parentThreadId: PARENT,
      childThreadId: 'subagent:test-2',
      task: 'summarize',
      depth: 1,
      orchestrator: false,
    });
    // Step 0: narration containing a complete <report> block + a tool call (non-terminal).
    // Step 1: the final report text. The block must reach the parent as its own message,
    // the final as another — and the block content must NOT appear twice.
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'file_read',
        input: JSON.stringify({ path: '/tmp/x' }),
        text: 'reading sources\n<report>two sources are paywalled; continuing with the rest</report>',
      },
      { type: 'text', text: 'summary: done (3 of 5 sources)' },
    ]);

    const run = await start(runSubagent, [
      { childThreadId: 'subagent:test-2', parentThreadId: PARENT, task: 'summarize', label: 'summarizer' },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const reports = (await ctx.store.recentWindow(PARENT)).filter(
      (m) => m.role === 'user' && m.senderName === 'summarizer',
    );
    expect(reports).toHaveLength(2); // the block, then the terminal report
    expect(reports[0]?.text).toContain('two sources are paywalled');
    expect(reports[1]?.text).toContain('summary: done');
    // Never re-delivered: the block content appears in exactly one parent message.
    expect(reports.filter((r) => r.text.includes('paywalled'))).toHaveLength(1);
    const [link] = await ctx.db.db
      .select()
      .from(subagentLinks)
      .where(eq(subagentLinks.childThreadId, 'subagent:test-2'));
    expect(link?.status).toBe('done');
  });

  it('a bare <no-report/> final delivers nothing and still closes the link done', async () => {
    ctx = await setupTestRuntime();
    await createLink(ctx.db.db, {
      parentThreadId: PARENT,
      childThreadId: 'subagent:test-3',
      task: 'check the feed; only report if something is actionable',
      depth: 1,
      orchestrator: false,
    });
    setTurnModel([{ type: 'text', text: '<no-report/>' }]);

    const run = await start(runSubagent, [
      { childThreadId: 'subagent:test-3', parentThreadId: PARENT, task: 'check', label: 'checker' },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const reports = (await ctx.store.recentWindow(PARENT)).filter(
      (m) => m.role === 'user' && m.senderName === 'checker',
    );
    expect(reports).toHaveLength(0); // the deliberate no-op delivers nothing
    const [link] = await ctx.db.db
      .select()
      .from(subagentLinks)
      .where(eq(subagentLinks.childThreadId, 'subagent:test-3'));
    expect(link?.status).toBe('done');
  });

  it('empty final without a sentinel falls back to the raw interim narration', async () => {
    ctx = await setupTestRuntime();
    await createLink(ctx.db.db, {
      parentThreadId: PARENT,
      childThreadId: 'subagent:test-4',
      task: 'dig',
      depth: 1,
      orchestrator: false,
    });
    // Narration + tool call, then an empty final (the cut-off/miss shape).
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'file_read',
        input: JSON.stringify({ path: '/tmp/x' }),
        text: 'found the config at /etc/app.conf, port is 8080',
      },
      { type: 'text', text: '' },
    ]);

    const run = await start(runSubagent, [
      { childThreadId: 'subagent:test-4', parentThreadId: PARENT, task: 'dig', label: 'digger' },
    ]);
    await run.returnValue;

    const reports = (await ctx.store.recentWindow(PARENT)).filter(
      (m) => m.role === 'user' && m.senderName === 'digger',
    );
    // The raw notes reach the parent (an agent reads messy notes better than a placeholder).
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('port is 8080');
  });
});
