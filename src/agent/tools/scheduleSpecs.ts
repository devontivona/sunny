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
        'timestamp (compute the absolute time, e.g. "in 30 min" or "tomorrow 9am"); kind ' +
        "'interval' with a duration like '2h'/'30m'/'1d'; or kind 'cron' with a 5-field cron " +
        `expression (evaluated in the user's timezone, ${timezone}). prompt = what you should ` +
        'do when it fires. The result is delivered automatically to whoever the schedule is for ' +
        '(the current person by default, or the "for" person).',
      inputSchema: z.object({
        kind: z
          .enum(['once', 'interval', 'cron'])
          .describe(
            "'once' (one-time, ISO timestamp) · 'interval' (recurring duration) · 'cron' (5-field " +
              'cron expression).',
          ),
        spec: z
          .string()
          .describe("once: ISO timestamp · interval: duration (e.g. '2h') · cron: '0 9 * * *'"),
        prompt: z.string().describe('What to do when it fires.'),
        label: z.string().optional().describe('Optional short label.'),
        for: z
          .string()
          .optional()
          .describe(
            'Optional: schedule this FOR another family member (a roster name, e.g. "Kate") — the ' +
              'fired run acts for and is delivered to THEM, not you. Omit to schedule for the ' +
              'current person. Roster members only.',
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
      'working for this conversation. The owner sees everyone\'s; a family member sees their own. ' +
      'Each row shows an id you can pass to cancel_run.',
    inputSchema: z.object({}),
  },
  cancel_run: {
    description:
      'Cancel a durable run by its id (from list_runs): deletes a schedule, or stops a running ' +
      "subagent of this conversation. You can only cancel runs you own (the owner can cancel any).",
    inputSchema: z.object({
      id: z.string().describe('The run id to cancel (a schedule id or a subagent id from list_runs).'),
    }),
  },
} as const;
