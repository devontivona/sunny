import { anthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { SunnyConfig } from '../config/index.js';

/**
 * Model wiring (D-PS3). `anthropic('claude-sonnet-5')` by default, provider-agnostic
 * so swapping models is a one-line change. `ANTHROPIC_API_KEY` is read from env by
 * the provider — we assert its presence at startup (see index.ts).
 */
export function getModel(config: SunnyConfig): LanguageModel {
  return anthropic(config.modelId);
}

/**
 * The cheap model for the delivery-recovery pass (D-MG8): when the main turn
 * produces text but never calls `send_message`/`stay_silent`, a one-shot pass on
 * this model rewrites the private notes into a clean iMessage (returned as plain
 * text — the runner does the delivery). Defaults to Haiku; overridable via
 * `config.recoveryModelId`.
 */
export function getRecoveryModel(config: SunnyConfig): LanguageModel {
  return anthropic(config.recoveryModelId);
}

/**
 * Anthropic provider options for agentic turns (D-PS3):
 * - `adaptive` thinking with `display: 'omitted'` (reasoning private, reinforces
 *   D-MG8) + the effort tier from config — OR thinking fully `disabled` when
 *   `config.thinking === 'off'` (no native private reasoning channel; the model's
 *   plain-text scratchpad becomes its reasoning space).
 */
export function anthropicProviderOptions(config: SunnyConfig) {
  if (config.thinking === 'off') {
    return { anthropic: { thinking: { type: 'disabled' as const } } };
  }
  return {
    anthropic: {
      thinking: { type: 'adaptive' as const, display: 'omitted' as const },
      effort: config.effort,
    },
  };
}
