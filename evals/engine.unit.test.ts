import { describe, expect, it } from 'vitest';
import { BudgetExceededError, CostMeter, estimateCostUsd } from './cost.js';
import {
  diffScorecards,
  summarizeDimensions,
  type CaseScore,
  type Scorecard,
} from './scorecard.js';
import { deliveredViaSendMessage, sendCount, toolCalled, toolNotCalled } from './graders.js';
import type { Trajectory } from './types.js';

function trajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    toolCalls: [],
    sends: [],
    delivered: 'silence',
    recovered: false,
    startJobs: [],
    finalText: '',
    scratch: '',
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    ...overrides,
  };
}

describe('estimateCostUsd', () => {
  it('prices uncached input, cached input, and output separately', () => {
    // Opus: $15/$1.5/$75 per MTok in/cachedIn/out.
    const cost = estimateCostUsd('claude-opus-4-8', {
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000,
    });
    // uncached 800k*15 + cached 200k*1.5 + out 100k*75, all /1e6
    expect(cost).toBeCloseTo(0.8 * 15 + 0.2 * 1.5 + 0.1 * 75, 6);
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
