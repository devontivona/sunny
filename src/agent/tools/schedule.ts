import { tool } from 'ai';
import type { Db } from '../../db/client.js';
import { createSchedule } from '../../scheduler/index.js';
import { scheduleToolSpecs } from './scheduleSpecs.js';

/**
 * In-process `schedule_create` (used by the read-only dashboard tool catalog). The durable
 * conversational turn registers the SAME spec (`scheduleToolSpecs`) with a `'use step'`-wrapped
 * execute for replay-safety — see `workflows/conversation.ts`. Inspection/cancellation is the
 * unified `list_runs` / `cancel_run` surface (run-audiences Phase 3.2), not schedule-specific
 * list/delete. Delivery defaults to the thread where the schedule was created.
 */
export function createScheduleTools(db: Db, ownerThreadId: string, timezone: string) {
  const specs = scheduleToolSpecs(timezone);

  const schedule_create = tool({
    ...specs.schedule_create,
    execute: async ({ kind, spec, prompt, label }) => {
      // Catalog-only surface (inert db): recurring cron schedules are standing FILES
      // created by the durable turn's step (workflows/conversation.ts); this in-process
      // path only ever handles the one-off reminder kind.
      if (kind === 'cron') {
        return 'Recurring schedules are standing files — create them from a conversation turn.';
      }
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

  return { schedule_create };
}
