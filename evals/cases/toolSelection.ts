import {
  backgroundedLongTask,
  deliveredReply,
  sentSomething,
  toolCalled,
  toolNotCalled,
} from '../graders.js';
import type { EvalCase } from '../types.js';

/**
 * Tool selection (task 8.4): the appropriate tool is chosen for a request — a
 * durable job for async research (after an "on it" send), scheduling for a timed
 * reminder, and NO heavyweight tool for a trivial greeting. Graded on the tool
 * calls in the trajectory (delegation is inert in the eval runtime — no `spawnChild` —
 * so a delegate_task choice is observed, not spawned).
 */
export const toolSelectionCases: EvalCase[] = [
  {
    name: 'tool-selection/research-starts-job',
    dimension: 'tool-selection',
    input: 'research the best noise-cancelling headphones under $300 and report back',
    // The POLICY is "background long work, keep the thread responsive" — since
    // unify-background-work, delegation is the only primitive that satisfies it;
    // grinding inline with dozens of calls violates it even if the eventual answer
    // is good.
    graders: [sentSomething, backgroundedLongTask],
  },
  {
    name: 'tool-selection/reminder-schedules',
    dimension: 'tool-selection',
    input: 'remind me to call the dentist at 9am tomorrow',
    graders: [toolCalled('schedule_create')],
  },
  {
    name: 'tool-selection/trivial-greeting-no-heavy-tools',
    dimension: 'tool-selection',
    input: 'hey sunny!',
    graders: [
      deliveredReply,
      toolNotCalled('delegate_task'),
      toolNotCalled('schedule_create'),
    ],
  },
];
