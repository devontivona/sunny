import { describe, expect, it } from 'vitest';
import { BudgetExceededError, CostMeter, estimateCostUsd } from './cost.js';
import {
  casePassed,
  SILENCE_TIER,
  cellSlug,
  diffScorecards,
  silenceTierGate,
  summarizeDimensions,
  type CaseScore,
  type Scorecard,
} from './scorecard.js';
import {
  deliveredViaSendMessage,
  scratchNotSecondPerson,
  sendCount,
  toolCalled,
  toolNotCalled,
} from './graders.js';
import { historyTier, type EvalCase, type Trajectory } from './types.js';

function trajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    toolCalls: [],
    sends: [],
    delivered: 'silence',
    recovered: false,
    startJobs: [],
    finalText: '',
    scratch: '',
    translatorUpdates: [],
    interimText: '',
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    ...overrides,
  };
}

describe('estimateCostUsd', () => {
  it('prices uncached input, cached input, and output separately', () => {
    // Opus 4.8: $5/$0.5/$25 per MTok in/cachedIn/out.
    const cost = estimateCostUsd('claude-opus-4-8', {
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000,
    });
    // uncached 800k*5 + cached 200k*0.5 + out 100k*25, all /1e6
    expect(cost).toBeCloseTo(0.8 * 5 + 0.2 * 0.5 + 0.1 * 25, 6);
  });

  it('falls back to a price for an unknown model', () => {
    expect(
      estimateCostUsd('mystery', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }),
    ).toBeGreaterThan(0);
  });
});

describe('CostMeter', () => {
  it('throws once the cap is reached', () => {
    const meter = new CostMeter(1);
    meter.add(0.4);
    expect(() => meter.assertWithinBudget()).not.toThrow();
    meter.add(0.7); // now $1.10 ≥ $1.00
    expect(() => meter.assertWithinBudget()).toThrow(BudgetExceededError);
    expect(meter.spentUsd).toBeCloseTo(1.1, 6);
  });
});

describe('programmatic graders', () => {
  // These graders are synchronous; `await` resolves the `Grader` union cleanly.
  it('deliveredViaSendMessage passes only for send_message delivery', async () => {
    expect(
      (await deliveredViaSendMessage(trajectory({ delivered: 'send_message' }), {} as never)).pass,
    ).toBe(true);
    expect(
      (await deliveredViaSendMessage(trajectory({ delivered: 'fallback_text' }), {} as never)).pass,
    ).toBe(false);
  });

  it('sendCount checks the exact number of bubbles', async () => {
    expect((await sendCount(2)(trajectory({ sends: ['a', 'b'] }), {} as never)).pass).toBe(true);
    expect((await sendCount(2)(trajectory({ sends: ['a'] }), {} as never)).pass).toBe(false);
  });

  it('toolCalled / toolNotCalled read the trajectory tool calls', async () => {
    const t = trajectory({ toolCalls: [{ name: 'schedule_create', input: {} }] });
    expect((await toolCalled('schedule_create')(t, {} as never)).pass).toBe(true);
    expect((await toolNotCalled('start_job')(t, {} as never)).pass).toBe(true);
    expect((await toolNotCalled('schedule_create')(t, {} as never)).pass).toBe(false);
  });
});

describe('scratchNotSecondPerson (advisory heuristic)', () => {
  it('vacuously passes on empty scratch (no scratch is the ideal)', async () => {
    const r = await scratchNotSecondPerson(trajectory({ scratch: '' }), {} as never);
    expect(r.pass).toBe(true);
    expect(r.advisory).toBe(true);
  });

  it('flags a composed reply written into scratch', async () => {
    const r = await scratchNotSecondPerson(
      trajectory({ scratch: "Going well on my end. How are you doing? Did you get your rest?" }),
      {} as never,
    );
    expect(r.pass).toBe(false);
    expect(r.advisory).toBe(true);
  });

  it('tolerates working notes with a lone user mention', async () => {
    const r = await scratchNotSecondPerson(
      trajectory({
        scratch:
          'Weighed beach vs city — user said warm, so leaning beach. Trimmed the budget ' +
          'airline options since they ("you") never book basic economy. Kept Miami and San Juan.',
      }),
      {} as never,
    );
    expect(r.pass).toBe(true);
  });
});

describe('casePassed (advisory exclusion)', () => {
  it('ignores failing advisory grades but honors failing gating grades', () => {
    const gating = { name: 'g', pass: true, score: 1 };
    const advisoryFail = { name: 'a', pass: false, score: 0, advisory: true };
    expect(casePassed([gating, advisoryFail])).toBe(true);
    expect(casePassed([{ ...gating, pass: false, score: 0 }, advisoryFail])).toBe(false);
    expect(casePassed([advisoryFail])).toBe(true);
  });
});

describe('historyTier', () => {
  const base: EvalCase = { name: 'x', dimension: 'elicitation', input: 'hi', graders: [] };
  it('derives live / seeded-clean / seeded-poisoned and honors the explicit tag', () => {
    expect(historyTier(base)).toBe('live');
    expect(
      historyTier({ ...base, setup: { conversation: [{ role: 'user', text: 'a' }] } }),
    ).toBe('seeded-clean');
    expect(
      historyTier({ ...base, setup: { fixtureTurns: [{ role: 'user', text: 'a' }] } }),
    ).toBe('seeded-poisoned');
    expect(
      historyTier({
        ...base,
        history: 'seeded-poisoned',
        setup: { conversation: [{ role: 'user', text: 'a' }] },
      }),
    ).toBe('seeded-poisoned');
  });
});

describe('cellSlug', () => {
  it('encodes only the forced knobs', () => {
    expect(cellSlug('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(cellSlug('claude-opus-4-8', { thinking: 'off', effort: 'low' })).toBe(
      'claude-opus-4-8__t-off__e-low',
    );
  });

  it('encodes the text-delivery grid axes', () => {
    expect(
      cellSlug('claude-sonnet-5', { deliveryMode: 'text', translatorHistory: 'excluded' }),
    ).toBe('claude-sonnet-5__d-text__th-excluded');
  });
});

describe('silenceTierGate (the d487a98 over-talk gate)', () => {
  const card = (rates: Record<string, number>): Scorecard => ({
    model: 'claude-sonnet-5',
    timestamp: 't',
    n: 5,
    costUsd: 0,
    dimensions: {},
    cases: SILENCE_TIER.map((name) => ({
      name,
      dimension: 'elicitation' as const,
      runs: 5,
      passes: Math.round((rates[name] ?? 0) * 5),
      passRate: rates[name] ?? 0,
      threshold: 0.6,
      pass: true,
      graderPasses: {},
    })),
  });

  it('passes when the text cell holds the tier at/above baseline', () => {
    const baseline = card(Object.fromEntries(SILENCE_TIER.map((n) => [n, 0.8])));
    const current = card(Object.fromEntries(SILENCE_TIER.map((n) => [n, 0.8])));
    const gate = silenceTierGate(baseline, current);
    expect(gate.pass).toBe(true);
    expect(gate.baselineMean).toBeCloseTo(0.8);
  });

  it('fails on an over-talk regression beyond epsilon', () => {
    const baseline = card(Object.fromEntries(SILENCE_TIER.map((n) => [n, 0.8])));
    const current = card(Object.fromEntries(SILENCE_TIER.map((n) => [n, 0.4])));
    expect(silenceTierGate(baseline, current).pass).toBe(false);
  });

  it('is not comparable (fails closed) without a baseline', () => {
    const current = card(Object.fromEntries(SILENCE_TIER.map((n) => [n, 1])));
    expect(silenceTierGate(null, current).pass).toBe(false);
  });
});

describe('scorecard summarize + diff', () => {
  const cases: CaseScore[] = [
    {
      name: 'a',
      dimension: 'elicitation',
      runs: 5,
      passes: 5,
      passRate: 1,
      threshold: 0.6,
      pass: true,
      graderPasses: {},
    },
    {
      name: 'b',
      dimension: 'elicitation',
      runs: 5,
      passes: 3,
      passRate: 0.6,
      threshold: 0.6,
      pass: true,
      graderPasses: {},
    },
  ];

  it('summarizes per-dimension pass rate as the case mean', () => {
    const dims = summarizeDimensions(cases);
    expect(dims.elicitation?.passRate).toBeCloseTo(0.8, 6);
    expect(dims.elicitation?.pass).toBe(true);
  });

  it('flags a per-case regression vs baseline', () => {
    const baseline: Scorecard = {
      model: 'claude-opus-4-8',
      timestamp: 't0',
      n: 5,
      costUsd: 0,
      dimensions: summarizeDimensions(cases),
      cases,
    };
    const worse: Scorecard = {
      ...baseline,
      timestamp: 't1',
      cases: [{ ...cases[0]!, passRate: 0.4, pass: false }, cases[1]!],
      dimensions: summarizeDimensions([{ ...cases[0]!, passRate: 0.4 }, cases[1]!]),
    };
    const regressions = diffScorecards(baseline, worse);
    expect(regressions.some((r) => r.scope === 'case:a')).toBe(true);
    expect(regressions.some((r) => r.scope === 'dimension:elicitation')).toBe(true);
  });

  it('returns no regressions when there is no baseline', () => {
    expect(
      diffScorecards(null, {
        model: 'm',
        timestamp: 't',
        n: 5,
        costUsd: 0,
        dimensions: {},
        cases: [],
      }),
    ).toEqual([]);
  });
});
