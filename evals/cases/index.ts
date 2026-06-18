import type { Dimension, EvalCase } from '../types.js';
import { elicitationCases } from './elicitation.js';
import { memoryCases } from './memory.js';
import { toolSelectionCases } from './toolSelection.js';

/** The full versioned dataset (task 7.2 loader). */
export const ALL_CASES: EvalCase[] = [...elicitationCases, ...memoryCases, ...toolSelectionCases];

/** Select cases by dimension; `'all'` (or undefined) returns the whole dataset. */
export function loadCases(dimension?: Dimension | 'all'): EvalCase[] {
  if (!dimension || dimension === 'all') return ALL_CASES;
  return ALL_CASES.filter((c) => c.dimension === dimension);
}

export { elicitationCases, memoryCases, toolSelectionCases };
