import { z } from 'zod';

/**
 * The `delegate_task` / `message_subagent` tool DEFINITIONS (description + schema), separated
 * from execution so the conversational workflow binds the prompt-shaping text + schema while the
 * side-effecting `execute` (a memoized `'use step'` reaching the in-process supervisor) is wired
 * per-tier. Node-free (zod only), matching `sendImageSpec`/`bashSpecs`. The descriptions encode
 * the delegation skill's when-to-delegate guidance (durable-subagents §1/§2/§5) so the model
 * delegates well without re-reading the skill each turn.
 */
export const DELEGATE_TASK_SPEC = {
  description:
    'Delegate a focused, self-contained subtask to a child subagent that runs in its OWN ' +
    'isolated context and reports back to this conversation when done — keeping its noisy ' +
    'intermediate work (large reads, dead ends) OUT of your context. This is ALSO how you ' +
    'background long or asynchronous work: use it INSTEAD of grinding through a long task ' +
    'inline (the chat is blocked while you work — promote anything beyond a few quick tool ' +
    'calls). Best for bounded or long-running work: research, building something, multi-source ' +
    'digest, summarizing a long thread, untrusted-content triage, an adversarial verify. NOT ' +
    'for coupled work where the child would need your evolving state (most code edits) — keep ' +
    'that on this thread. Write a COMPLETE brief: the child sees NONE of this conversation, so ' +
    'state (1) the objective, (2) the output format you want back, (3) which tools/sources to ' +
    'use, and (4) clear boundaries. You do NOT block — your reply just tells the user you are ' +
    'on it; the report arrives later like a new message, and you summarize it for the user ' +
    'then. You can run a few children at once and synthesize.',
  inputSchema: z.object({
    task: z
      .string()
      .min(1)
      .describe(
        'The complete, self-contained brief: objective, desired output format, tools/sources ' +
          'to use, and boundaries. Assume the child knows nothing about this conversation.',
      ),
    label: z
      .string()
      .optional()
      .describe('A short name for this subagent (e.g. "researcher", "verifier") for attribution.'),
    toolset: z
      .enum(['host', 'readonly'])
      .optional()
      .describe(
        'Toolset preset for the child: "host" (the default — full working set: bash, file tools, ' +
          'memory, registries; never broader than yours) or "readonly" (reads only: file_read + ' +
          'memory reads — reserve for work needing extra care, e.g. triaging untrusted content ' +
          'like a suspicious page or email).',
      ),
    model: z
      .enum(['sonnet', 'opus', 'haiku'])
      .optional()
      .describe(
        'Which model the child runs on (D-DS9): "sonnet" (the default — bounded, well-specified ' +
          'work: research, reads, extraction, single-purpose subtasks), "opus" (hard reasoning, ' +
          'synthesis, or high-stakes/adversarial verification), "haiku" (cheap + fast for simple, ' +
          'high-volume classification/extraction). Tier deliberately — a strong lead delegating ' +
          'to cheaper workers is the cost-effective shape; reserve opus for children whose ' +
          'judgement quality actually matters.',
      ),
  }),
} as const;

/** Friendly delegate model names → concrete model ids (matches the codebase's lineup;
 *  `haiku` aligns with the recovery model). Keeps the agent-facing tool surface stable even
 *  if the underlying ids change. */
export const CHILD_MODELS = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
} as const;

export type ChildModelName = keyof typeof CHILD_MODELS;

/** Resolve a friendly model name to its id, or undefined (→ the child's default model). */
export function resolveChildModel(name?: string): string | undefined {
  return name && name in CHILD_MODELS ? CHILD_MODELS[name as ChildModelName] : undefined;
}
