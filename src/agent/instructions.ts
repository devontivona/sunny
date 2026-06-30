import type { SystemModelMessage } from 'ai';
import type { SunnyConfig } from '../config/index.js';
import { loadCore, memoryPaths } from '../memory/index.js';
import { loadAllSkills, renderSkillIndex } from '../skills/index.js';
import { buildSystemPrompt, type DeliveryMode, type PeoplePromptContext } from './prompt.js';

/**
 * Assemble a conversational turn's `instructions` (durable-main-loop task 1.1).
 *
 * Shared by the in-process loop (`loop.ts`) and the durable conversational
 * workflow so both build a byte-identical system prefix. Re-reads the always-on
 * memory core per call (agent-memory D3) — so hand-edits and mid-turn writes take
 * effect immediately — and renders the skills index from the live skill set.
 *
 * The result is a `SystemModelMessage` carrying the 5-min ephemeral cache
 * breakpoint (D-PS4 / R2): steps 2..N of a multi-step turn, and any message within
 * the TTL, then read the stable prefix (tools + system + memory core) at ~0.1x
 * instead of re-paying full input price. `DurableAgent` honors `cacheControl` on the
 * `SystemModelMessage` instructions form, so the durable path keeps the same cache
 * behavior as the in-process loop — verify via `cachedIn` / `cacheWriteIn`.
 *
 * Has filesystem side effects (reads memory + skills): the workflow must call it
 * inside a `'use step'` so the assembled prefix stays stable across replays.
 */
export function assembleTurnInstructions(
  config: SunnyConfig,
  deliveryMode: DeliveryMode = 'tool',
  people?: PeoplePromptContext,
): SystemModelMessage {
  const paths = memoryPaths(config.runtimeDir);
  return {
    role: 'system',
    content: buildSystemPrompt(
      config,
      loadCore(paths),
      deliveryMode,
      renderSkillIndex(loadAllSkills(config), config.skills),
      people,
    ),
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  };
}
