import { z } from 'zod';

/**
 * Self-scheduling tool SPECS (scheduling D-SC3; run-audiences Phase 1a). Node-free
 * (zod only — no scheduler/cron/db imports at module scope), so the durable workflow
 * (`workflows/conversation.ts`) can import these and register the tools with
 * `'use step'`-wrapped executes, exactly as it does for `MEMORY_TOOL_SPECS` /
 * `BASH_TOOL_SPECS`. The in-process `createScheduleTools` (dashboard catalog) reuses the
 * same specs. Timezone is interpolated into the `schedule_create` description as guidance.
 *
 * Registered on interactive turns of any trusted DM (owner or family); scheduled runs never
 * get them (anti-recursion, D-SC4). Delivery defaults to the thread where it was created.
 */
export function scheduleToolSpecs(timezone: string) {
  return {
    schedule_create: {
      description:
        'Schedule yourself to do something later or on a recurring basis. Translate the ' +
        "user's natural-language timing into a canonical form: kind 'once' with an ISO 8601 " +
        'timestamp (compute the absolute time, e.g. "in 30 min" or "tomorrow 9am") for a ' +
        "one-off reminder; or kind 'cron' with a 5-field cron expression (evaluated in the " +
        `user's timezone, ${timezone}) for anything recurring — translate periods to cron ` +
        '(e.g. "every 2 hours" → "0 */2 * * *"). A cron schedule becomes a STANDING schedule: ' +
        'a portable file in state/schedules/ that is part of your identity and survives ' +
        'machine moves — give it a meaningful label, and keep its prompt LIGHT (point at a ' +
        'skill for any nontrivial procedure). prompt = what you should do when it fires. ' +
        'AUDIENCE (deliver_to): the fired run REPORTS to that person\'s conversation loop — ' +
        'you relay it to them in your own voice with the conversation\'s context — it never ' +
        'texts anyone directly. Pick by what the job PRODUCES: an artifact (files, a feed, ' +
        'tagged docs, DB state) → deliver_to "nobody" (outcomes stay inspectable in run ' +
        'history; no conversation is woken); a message for a person → their name, and write ' +
        'the prompt so reporting is CONDITIONAL ("report only if X; otherwise reply exactly ' +
        '<no-report/>"), never an unconditional "report what was processed" — that is how ' +
        'hourly spam happens.',
      inputSchema: z.object({
        kind: z
          .enum(['once', 'cron'])
          .describe(
            "'once' (one-time reminder, ISO timestamp) · 'cron' (recurring standing schedule, " +
              '5-field cron expression).',
          ),
        spec: z
          .string()
          .describe("once: ISO timestamp · cron: '0 9 * * *' (5-field, user's timezone)"),
        prompt: z.string().describe('What to do when it fires.'),
        label: z
          .string()
          .optional()
          .describe(
            'Short kebab-case label. Effectively required for cron (it names the standing ' +
              "schedule's file); optional for once.",
          ),
        deliver_to: z
          .string()
          .optional()
          .describe(
            'The AUDIENCE — whose conversation loop receives the fired run\'s reports: a ' +
              'roster name (e.g. "Kate"; their loop relays to them), or "nobody" for a silent ' +
              'artifact/pipeline job (record-only). Omit for the current person.',
          ),
        // Deprecated alias of deliver_to (pre-collapse name). Kept in the schema because a
        // non-strict zod object silently STRIPS unknown keys: a model imitating an old
        // schedule_create call from recorded history would otherwise have its cross-person
        // addressing dropped with a success confirmation (code-review 2026-07-15).
        for: z.string().optional().describe('Deprecated: use deliver_to.'),
        toolset: z
          .enum(['host', 'readonly'])
          .optional()
          .describe(
            'The AUTHORITY preset for the fired run — the same vocabulary as delegate_task: ' +
              '"host" (the default — full working set: bash, file tools, memory, registries, ' +
              'live MCP server tools; never broader than yours) or "readonly" (reads only — ' +
              'reserve for runs needing extra care, e.g. recurring digestion of untrusted ' +
              'content). Every scheduled run can message the roster; none can schedule or ' +
              'delegate.',
          ),
      }),
    },
  };
}

/**
 * Run-lifecycle tool specs (run-audiences D-RA8, Phase 3.2). `list_runs` / `cancel_run` are the
 * unified inspection surface spanning **schedules + running subagents** — they replace the
 * schedule-specific list/delete. Node-free (zod only). Ownership is enforced in the step (the
 * caller sees/cancels their own runs; the owner sees/cancels all).
 */
export const RUNS_TOOL_SPECS = {
  list_runs: {
    description:
      'List the durable runs you can see: your active schedules and any subagents currently ' +
      "working for this conversation. The owner sees everyone's; a family member sees their own. " +
      'Each row shows an id you can pass to cancel_run.',
    inputSchema: z.object({}),
  },
  cancel_run: {
    description:
      'Cancel a durable run by its id (from list_runs): deletes a schedule, or stops a running ' +
      'subagent of this conversation. You can only cancel runs you own (the owner can cancel any).',
    inputSchema: z.object({
      id: z
        .string()
        .describe('The run id to cancel (a schedule id or a subagent id from list_runs).'),
    }),
  },
} as const;
