import type { TurnUsage } from './types.js';

/**
 * Cost estimation + cap (task 7.7). Evals spend real money, so a run that would
 * exceed its budget stops and reports rather than continuing to spend.
 *
 * Prices are approximate USD per million tokens and are easy to update; they only
 * drive the budget guard, not billing. (When `observability` lands, the cost
 * meter moves onto its budget machinery — task 9.2.)
 */
interface Price {
  inPerMTok: number;
  outPerMTok: number;
  cachedInPerMTok: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-4-8': { inPerMTok: 15, outPerMTok: 75, cachedInPerMTok: 1.5 },
  'claude-sonnet-4-6': { inPerMTok: 3, outPerMTok: 15, cachedInPerMTok: 0.3 },
};

const FALLBACK_PRICE: Price = { inPerMTok: 15, outPerMTok: 75, cachedInPerMTok: 1.5 };

export function estimateCostUsd(modelId: string, usage: TurnUsage): number {
  const p = PRICES[modelId] ?? FALLBACK_PRICE;
  const uncachedIn = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncachedIn * p.inPerMTok +
      usage.cachedInputTokens * p.cachedInPerMTok +
      usage.outputTokens * p.outPerMTok) /
    1_000_000
  );
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly capUsd: number,
  ) {
    super(
      `eval cost cap reached: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} — stopping`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** Tracks cumulative spend and enforces a hard cap. */
export class CostMeter {
  private spent = 0;
  constructor(private readonly capUsd: number) {}

  add(usd: number): void {
    this.spent += usd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  /** Throw if the budget is already exhausted — call before the next paid run. */
  assertWithinBudget(): void {
    if (this.spent >= this.capUsd) throw new BudgetExceededError(this.spent, this.capUsd);
  }
}
