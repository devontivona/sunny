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
    'isolated context and reports back to you when done — keeping its noisy intermediate work ' +
    '(large reads, dead ends) OUT of your context. Best for bounded, parallelizable, ' +
    'read/explore/contain work: research, multi-source digest, summarizing a long thread, ' +
    'untrusted-content triage, an adversarial verify of a finding. NOT for coupled work where ' +
    'the child would need your evolving state (most code edits) — keep that on this thread. ' +
    'Write a COMPLETE brief: the child sees NONE of this conversation, so state (1) the ' +
    'objective, (2) the output format you want back, (3) which tools/sources to use, and (4) ' +
    'clear boundaries. You do NOT block — the report arrives later like a new message, and you ' +
    'can run a few children at once and synthesize. If it will take a while, tell the user you ' +
    'are on it (via send_message) first.',
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
      .enum(['readonly', 'host', 'none'])
      .optional()
      .describe(
        'Least-privilege tools for the child: "readonly" (file_read only; the default), "host" ' +
          '(bash + file_read, for work that must act), "none" (NO tools — for containing ' +
          'untrusted content).',
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

export const MESSAGE_SUBAGENT_SPEC = {
  description:
    'Send a steering message to a child subagent that is still working (use the id returned by ' +
    'delegate_task). Use it to pass new information or adjust course; the child folds it into ' +
    'its work at its next step. Prefer this over aborting + re-delegating unless the task itself ' +
    'is invalidated. Do not micromanage.',
  inputSchema: z.object({
    child: z.string().min(1).describe('The subagent id returned by delegate_task.'),
    text: z.string().min(1).describe("The message/instruction to fold into the child's work."),
  }),
} as const;
