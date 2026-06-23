import { anthropic } from '@ai-sdk/anthropic';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SteerHandle } from '../src/agent/dispatcher.js';
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
