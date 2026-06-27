import { readFileSync } from 'node:fs';
import { anthropic } from '@ai-sdk/anthropic';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { runRecoveryPass } from '../src/agent/recovery.js';

/**
 * Real-model regression for the delivery-recovery backstop (D-MG8) — exercised by calling the
 * SHARED `runRecoveryPass` directly (the same function the durable turn invokes via its
 * `recoverDelivery` step → `getRecoveryModel(config)`), so it guards the recovery LOGIC
 * independent of which turn path calls it. The durable turn's end-to-end miss→recovery→deliver
 * wiring is verified live via the loopback channel (a deterministic version would need a
 * recovery-model test seam — deferred).
 *
 * NOT gated: these call a paid model on every CI run (cheap — one Haiku call each). They need
 * ANTHROPIC_API_KEY (loaded by tests/setup/env.ts); without it the real call fails loudly.
 */

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
