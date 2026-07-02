import { describe, expect, it } from 'vitest';
import { CHILD_MODELS, resolveChildModel } from './delegationSpecs.js';

/** Delegate model selection (durable-subagents D-DS9): the agent-facing friendly names map to the
 *  codebase's concrete model ids, and anything else falls back to the child's default. */
describe('resolveChildModel', () => {
  it('maps friendly names to model ids', () => {
    expect(resolveChildModel('sonnet')).toBe('claude-sonnet-5');
    expect(resolveChildModel('opus')).toBe('claude-opus-4-8');
    expect(resolveChildModel('haiku')).toBe('claude-haiku-4-5');
  });

  it('returns undefined (→ default model) for absent or unknown names', () => {
    expect(resolveChildModel(undefined)).toBeUndefined();
    expect(resolveChildModel('gpt-4')).toBeUndefined();
    expect(resolveChildModel('')).toBeUndefined();
  });

  it('haiku aligns with the recovery-model lineup', () => {
    expect(CHILD_MODELS.haiku).toBe('claude-haiku-4-5');
  });
});
