import { defineEventHandler } from 'nitro/h3';
import { start } from 'workflow/api';
import { runJob } from '../../../workflows/job.js';

/**
 * Dev-only: start a durable job directly to smoke-test the WDK pipeline.
 * Gated by SUNNY_DEBUG=1. Body: { threadId, task }.
 */
export default defineEventHandler(async (event) => {
  if (process.env.SUNNY_DEBUG !== '1') {
    return new Response('debug disabled (set SUNNY_DEBUG=1)', { status: 403 });
  }
  const body = (await event.req.json().catch(() => ({}))) as { threadId?: string; task?: string };
  const run = await start(runJob, [
    {
      threadId: body.threadId ?? 'debug',
      task: body.task ?? 'Reply with a one-line confirmation that the durable job pipeline works.',
      ownerName: 'Devon',
    },
  ]);
  return { runId: run.runId };
});
