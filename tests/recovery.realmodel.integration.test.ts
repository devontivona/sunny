import { readFileSync } from 'node:fs';
import { anthropic } from '@ai-sdk/anthropic';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SteerHandle } from '../src/agent/dispatcher.js';
import { runRecoveryPass } from '../src/agent/recovery.js';
import { REAL_MISSES } from '../evals/cases/fixtures/realMisses.js';
import { createTestDb, type TestDb } from './db.js';
import { createTestRuntime } from './harness.js';
import { makeChannelEvent } from './factories.js';
import { modelThatOnlyScratches } from './fakes/model.js';

const NO_STEER: SteerHandle = { drain: () => [] };

/**
 * Real-model recovery regression (D-MG8). This is the test the old forced-tool
 * backstop never had: it drives a GUARANTEED elicitation miss (the primary model
 * only scratches, never sends) and routes recovery through the REAL Haiku model —
 * the exact path that, in production, reported `recovered=true` while delivering
 * nothing. The fixtures are real captured prod misses (`evals/cases/fixtures`).
 *
 * NOT gated: this calls a paid model on every CI run (cheap — one Haiku call per
 * case). It needs ANTHROPIC_API_KEY (loaded by tests/setup/env.ts from .env locally
 * or the CI secret); without it the real call fails loudly, which is intended.
 */
describe('delivery-recovery against the real Haiku model', () => {
  let tdb: TestDb;
  beforeEach(async () => {
    tdb = await createTestDb();
  });
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 25)); // let the consolidation seed settle
    await tdb.teardown();
  });

  // A representative spread of real prod misses with substantive scratch.
  const cases = REAL_MISSES.filter((m) => m.scratch.length > 150).slice(0, 3);

  it.each(cases)('recovers a real miss: $name', async (miss) => {
    const rt = createTestRuntime({
      db: tdb.db,
      // Primary model writes the reply as private scratch and never sends — a miss.
      model: modelThatOnlyScratches(miss.scratch),
      // The thing under test: the REAL backstop, not a mock.
      recoveryModel: anthropic('claude-haiku-4-5'),
    });
    const ev = makeChannelEvent({ text: miss.user || 'go on' });
    await rt.store.appendInbound(ev);
    await rt.runTurn(ev, NO_STEER);

    // The backstop fired and actually delivered a message (no ghosting).
    const sends = rt.gateway.texts();
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.join('').trim().length).toBeGreaterThan(0);

    const turn = (await rt.store.recentWindow(ev.threadId)).find((m) => m.role === 'assistant');
    const payload = turn!.payload as {
      parts: Array<{ type: string }>;
      metadata?: { delivered?: string; recovered?: boolean };
    };
    expect(payload.metadata?.recovered).toBe(true);
    expect(payload.metadata?.delivered).toBe('send_message');
    // Recovered send is coerced into history as a send_message tool call (de-poison).
    expect(payload.parts.some((p) => p.type === 'tool-send_message')).toBe(true);
  });
});

/**
 * Regression for the production ghosting captured 2026-06-24 (the "fetch HN top
 * story" miss). The fixture is the ACTUAL failing turn pulled from the Langfuse
 * trace — its full message trajectory (tool-call/tool-result/reasoning parts) +
 * the scratch the backstop was given. Fed raw to Haiku this returns EMPTY every
 * time (verified: 3/3 — the user was ghosted); `runRecoveryPass`'s text-only
 * sanitization makes it reliably non-empty. Synthetic inputs do NOT reproduce
 * this, so the real captured trajectory is the only honest guard — without the
 * sanitization this test fails.
 */
describe('delivery-recovery on the captured ghost trajectory (real Haiku)', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../evals/cases/fixtures/recoveryGhostTrajectory.json', import.meta.url),
      'utf8',
    ),
  ) as { scratch: string; messages: ModelMessage[] };

  it('recovers the real ghosted turn (non-empty reply)', async () => {
    const out = await runRecoveryPass({
      model: anthropic('claude-haiku-4-5'),
      ownerName: 'Devon',
      messages: fixture.messages,
      scratch: fixture.scratch,
      threadId: 'regression-ghost-trajectory',
    });

    // The bug was an empty composition → user ghosted. Must be a real message now.
    expect(out.trim().length).toBeGreaterThan(0);
  });
});

/**
 * When the turn completed in one go, the scratch accumulates interim progress lines
 * ("on it", "give me a few minutes") AND the final result. The backstop delivers ONE
 * message after the turn is done, so it must send the FINAL state — not stitch a
 * "give me a minute" progress line onto a "done, it's live" completion (observed in
 * the wild on a website-builder turn). The prompt now collapses that.
 */
describe('delivery-recovery collapses interim progress on a completed turn (real Haiku)', () => {
  it('sends the final result, dropping contradictory progress chatter', async () => {
    const scratch = [
      "On it — I'll build the one-pager and host it. Give me a few minutes.",
      'Style picked (terminal). Writing the page.',
      "Done — it's live: https://example.waywardlane.com — built with website-builder, hosted via devbox. Want any changes?",
    ].join('\n');
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Build a one-pager about X and host it.' }] },
    ] as unknown as ModelMessage[];

    const out = await runRecoveryPass({
      model: anthropic('claude-haiku-4-5'),
      ownerName: 'Devon',
      messages,
      scratch,
      threadId: 'regression-progress-collapse',
    });

    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toContain('https://example.waywardlane.com'); // the actual result is delivered
    // No contradictory "still working" progress alongside the completion.
    expect(out.toLowerCase()).not.toMatch(/give me a (few )?minute|one moment|working on it/);
  });
});
