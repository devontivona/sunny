import { z } from 'zod';

/**
 * The `start_job` tool DEFINITION (description + input schema), separated from
 * execution (the `*Specs.ts` split). The conversational turn binds it to
 * `startJobStep` (workflows/conversation.ts); the dashboard tool catalog reads the
 * same spec, so the model-facing contract can never drift between the two.
 */
export const START_JOB_SPEC = {
  description:
    'Promote a long-running or asynchronous task to a durable background job. Use this ' +
    "for work that takes a while (research, building something, multi-step tasks you can't " +
    'finish in one quick reply). The job runs to completion even across restarts and ' +
    'messages the user with the result when done. ' +
    'Use this INSTEAD of working through a long task inline — the chat is blocked ' +
    'while you work, so promote anything beyond a few quick tool calls (do not grind ' +
    'through research with dozens of calls in the conversation). After calling this, ' +
    'your reply just tells the user you are on it; the job reports back separately.',
  inputSchema: z.object({
    task: z
      .string()
      .describe(
        'A complete, self-contained description of the task to perform in the background.',
      ),
  }),
} as const;
