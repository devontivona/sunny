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
