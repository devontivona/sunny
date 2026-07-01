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
        'do when it fires. The result is delivered to the user automatically.',
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
      }),
    },
    schedule_list: {
      description: 'List your active schedules.',
      inputSchema: z.object({}),
    },
    schedule_delete: {
      description: 'Delete (cancel) a schedule by its id.',
      inputSchema: z.object({
        id: z.string().describe('The schedule id to cancel (from schedule_list).'),
      }),
    },
  };
}

/** One active-schedule row's display shape (subset of `ScheduleRow`), kept local so this
 *  module stays node-free (no db/schema value import). */
interface ScheduleListItem {
  id: string;
  kind: string;
  spec: string;
  label: string | null;
  nextRunAt: Date | null;
  prompt: string;
}

/** Format an active-schedules listing (shared by the in-process tool and the durable step). */
export function formatScheduleList(rows: ScheduleListItem[]): string {
  if (rows.length === 0) return '(no active schedules)';
  return rows
    .map(
      (r) =>
        `${r.id} [${r.kind} ${r.spec}]${r.label ? ` "${r.label}"` : ''} next ${r.nextRunAt?.toISOString() ?? 'n/a'}: ${r.prompt.slice(0, 60)}`,
    )
    .join('\n');
}
