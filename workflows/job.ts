import { type ModelMessage, type UIMessageChunk } from 'ai';
import { DurableAgent } from '@workflow/ai/agent';
import { anthropic } from '@workflow/ai/anthropic';
import { getWritable } from 'workflow';

/**
 * Tier-2 durable job (durable-execution D-DE1/2/3, tasks 4.2/4.3). Runs a
 * `DurableAgent` at the workflow level, so each LLM call (and, once tools are
 * added in Phase 4, each tool call) is a durable step — the job survives
 * crashes/reboots and resumes from its last completed step. On completion it
 * notifies the user via the gateway (single write, D-DE3). Promoted from a
 * conversational turn via `start_job`.
 *
 * NB: `start_job` currently has NO tools — this is a single durable generation.
 * When Phase 4 gives background jobs research/build tools, they slot in as
 * step-wrapped tool `execute`s and this loop becomes a true multi-step durable
 * agent with mid-run resume, no further restructuring needed.
 */
export interface JobInput {
  threadId: string;
  task: string;
  ownerName: string;
}

export async function runJob(input: JobInput): Promise<void> {
  'use workflow';

  const agent = new DurableAgent({
    model: anthropic('claude-opus-4-8'),
    instructions:
      `You are Sunny, ${input.ownerName}'s personal assistant, completing a task in the ` +
      `background. Do the task as best you can, then write a concise, friendly result ` +
      `message to send to ${input.ownerName} over iMessage (plain text, no markdown).`,
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high' },
    },
  });

  const result = await agent.stream({
    messages: [{ role: 'user', content: input.task }],
    writable: getWritable<UIMessageChunk>(),
  });

  const text = finalAssistantText(result.messages) || 'Done — but I came up empty on that one.';
  await deliver(input.threadId, text);
}

/** Final assistant text from the run's messages (the delivery payload). */
function finalAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    if (typeof m.content === 'string') return m.content.trim();
    return m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
      .trim();
  }
  return '';
}

/** Deliver the result to the user via the gateway (proactive send). */
async function deliver(threadId: string, text: string): Promise<void> {
  'use step';

  const { getRuntime } = await import('../src/runtime.js');
  const { gateway } = await getRuntime();
  await gateway.send(threadId, { text });
}
