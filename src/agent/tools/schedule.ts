import { tool } from 'ai';
import type { Db } from '../../db/client.js';
import { createSchedule, deleteSchedule, listSchedules } from '../../scheduler/index.js';
import { formatScheduleList, scheduleToolSpecs } from './scheduleSpecs.js';

/**
 * In-process self-scheduling tools (used by the read-only dashboard tool catalog). The durable
 * conversational turn registers the SAME specs (`scheduleToolSpecs`) with `'use step'`-wrapped
 * executes for replay-safety — see `workflows/conversation.ts`. Delivery defaults to the thread
 * where the schedule was created.
 */
export function createScheduleTools(db: Db, ownerThreadId: string, timezone: string) {
  const specs = scheduleToolSpecs(timezone);

  const schedule_create = tool({
    ...specs.schedule_create,
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
    ...specs.schedule_list,
    execute: async () => formatScheduleList(await listSchedules(db)),
  });

  const schedule_delete = tool({
    ...specs.schedule_delete,
    execute: async ({ id }) => {
      const ok = await deleteSchedule(db, id);
      return ok ? `Deleted schedule ${id}.` : `No schedule with id ${id}.`;
    },
  });

  return { schedule_create, schedule_list, schedule_delete };
}
