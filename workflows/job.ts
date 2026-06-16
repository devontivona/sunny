import { generateText } from 'ai';

/**
 * Tier-2 durable job (durable-execution D-DE1/2/3, tasks 4.2/4.3).
 *
 * A `"use workflow"` orchestrator whose side effects live in `"use step"` units,
 * so the job survives crashes/reboots and resumes from its last completed step
 * rather than restarting. On completion it notifies the user via the gateway
 * (single write, D-DE3). Promoted from a conversational turn via `start_job`.
 */
export interface JobInput {
  threadId: string;
  task: string;
  ownerName: string;
}

export async function runJob(input: JobInput): Promise<void> {
  'use workflow';

  const result = await doWork(input.task, input.ownerName);
  await deliver(input.threadId, result);
}

/** The actual work — a retryable durable step with full Node access. */
async function doWork(task: string, ownerName: string): Promise<string> {
  'use step';

  const { getModel } = await import('../src/agent/model.js');
  const model = getModel({ modelId: 'claude-opus-4-8' } as never);
  const { text } = await generateText({
    model,
    system:
      `You are Sunny, ${ownerName}'s personal assistant, completing a task in the ` +
      `background. Do the task as best you can, then write a concise, friendly result ` +
      `message to send to ${ownerName} over iMessage (plain text, no markdown).`,
    prompt: task,
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
  });
  return text.trim() || 'Done — but I came up empty on that one.';
}

/** Deliver the result to the user via the gateway (proactive send). */
async function deliver(threadId: string, text: string): Promise<void> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { gateway } = await getRuntime();
  await gateway.send(threadId, { text });
}
