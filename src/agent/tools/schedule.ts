import { tool } from 'ai';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { createSchedule, deleteSchedule, listSchedules } from '../../scheduler/index.js';

/**
 * Self-scheduling tools (scheduling D-SC3). Provided ONLY on interactive turns —
 * scheduled runs don't get them (anti-recursion, D-SC4). Delivery defaults to the
 * thread where the schedule was created.
 */
export function createScheduleTools(db: Db, ownerThreadId: string, timezone: string) {
  const schedule_create = tool({
    description:
      'Schedule yourself to do something later or on a recurring basis. Translate the ' +
      "user's natural-language timing into a canonical form: kind 'once' with an ISO 8601 " +
      'timestamp (compute the absolute time, e.g. "in 30 min" or "tomorrow 9am"); kind ' +
      "'interval' with a duration like '2h'/'30m'/'1d'; or kind 'cron' with a 5-field cron " +
      `expression (evaluated in the user's timezone, ${timezone}). prompt = what you should ` +
      'do when it fires. The result is delivered to the user automatically.',
    inputSchema: z.object({
      kind: z.enum(['once', 'interval', 'cron']),
      spec: z
        .string()
        .describe("once: ISO timestamp · interval: duration (e.g. '2h') · cron: '0 9 * * *'"),
      prompt: z.string().describe('What to do when it fires.'),
      label: z.string().optional().describe('Optional short label.'),
    }),
    execute: async ({ kind, spec, prompt, label }) => {
      try {
        const row = await createSchedule(db, {
          kind,
          spec,
          prompt,
          threadId: ownerThreadId,
          timezone,
          label,
        });
        return `Scheduled ${row.id} (${kind}); next run ${row.nextRunAt?.toISOString() ?? 'n/a'}.`;
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  const schedule_list = tool({
    description: 'List your active schedules.',
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await listSchedules(db);
      if (rows.length === 0) return '(no active schedules)';
      return rows
        .map(
          (r) =>
            `${r.id} [${r.kind} ${r.spec}]${r.label ? ` "${r.label}"` : ''} next ${r.nextRunAt?.toISOString() ?? 'n/a'}: ${r.prompt.slice(0, 60)}`,
        )
        .join('\n');
    },
  });

  const schedule_delete = tool({
    description: 'Delete (cancel) a schedule by its id.',
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const ok = await deleteSchedule(db, id);
      return ok ? `Deleted schedule ${id}.` : `No schedule with id ${id}.`;
    },
  });

  return { schedule_create, schedule_list, schedule_delete };
}
