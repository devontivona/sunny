import { anthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { SunnyConfig } from '../config/index.js';

/**
 * Model wiring (D-PS3). `anthropic('claude-opus-4-8')` by default, provider-agnostic
 * so swapping models is a one-line change. `ANTHROPIC_API_KEY` is read from env by
 * the provider — we assert its presence at startup (see index.ts).
 */
export function getModel(config: SunnyConfig): LanguageModel {
  return anthropic(config.modelId);
}

/**
 * The cheap model for the delivery-recovery pass (D-MG8): when the main turn
 * produces text but never calls `send_message`/`stay_silent`, a forced one-shot
 * pass on this model composes the message (or chooses silence). Runs WITHOUT
 * thinking so the forced tool call is permitted (forcing ⊥ extended thinking on
 * Anthropic). Defaults to Haiku; overridable via `config.recoveryModelId`.
 */
export function getRecoveryModel(config: SunnyConfig): LanguageModel {
  return anthropic(config.recoveryModelId);
}

/**
 * Anthropic provider options for agentic turns (D-PS3):
 * - adaptive thinking, `display: 'omitted'` so reasoning is private and never
 *   reaches the user (reinforces D-MG8: raw model output is private).
 * - effort tier from config (default `high`).
 */
export function anthropicProviderOptions(config: SunnyConfig) {
  return {
    anthropic: {
      thinking: { type: 'adaptive' as const, display: 'omitted' as const },
      effort: config.effort,
    },
  };
}
