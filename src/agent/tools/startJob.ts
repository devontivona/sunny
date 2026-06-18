import { tool } from 'ai';
import { z } from 'zod';
import { start } from 'workflow/api';
import { runJob } from '../../../workflows/job.js';

/**
 * `start_job` (durable-execution D-DE1, task 4.2): promote long/async work to a
 * durable Tier-2 job. The job runs to completion independently of this turn,
 * survives restarts, and messages the user with the result when done.
 */
export function createStartJobTool(threadId: string, ownerName: string) {
  return tool({
    description:
      'Promote a long-running or asynchronous task to a durable background job. Use this ' +
      "for work that takes a while (research, building something, multi-step tasks you can't " +
      'finish in one quick reply). The job runs to completion even across restarts and ' +
      'messages the user with the result when done. Tell the user you are on it (via ' +
      'send_message) first, then call this.',
    inputSchema: z.object({
      task: z
        .string()
        .describe(
          'A complete, self-contained description of the task to perform in the background.',
        ),
    }),
    execute: async ({ task }) => {
      const run = await start(runJob, [{ threadId, task, ownerName }]);
      return `Started durable background job ${run.runId}; it will message the user on completion.`;
    },
  });
}
