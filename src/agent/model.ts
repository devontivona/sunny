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
 * The cheap utility model: the interim-progress translator and the abnormal-turn-end
 * backstop (a turn that ended without final reply text — step limit, length cap, or an
 * error finish). Defaults to Haiku; overridable via `config.utilityModelId`.
 */
export function getUtilityModel(config: SunnyConfig): LanguageModel {
  return anthropic(config.utilityModelId);
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
