import { describe, expect, it } from 'vitest';
import { anthropicProviderOptions } from './model.js';
import { makeConfig } from '../../tests/factories.js';

describe('anthropicProviderOptions', () => {
  it('uses adaptive thinking (private) + effort by default', () => {
    const opts = anthropicProviderOptions(makeConfig({ effort: 'high' }));
    expect(opts.anthropic.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(opts.anthropic.effort).toBe('high');
  });

  it('disables thinking when config.thinking is off (no effort)', () => {
    const opts = anthropicProviderOptions(makeConfig({ thinking: 'off' }));
    expect(opts.anthropic.thinking).toEqual({ type: 'disabled' });
    expect('effort' in opts.anthropic).toBe(false);
  });
});
