import {
  deliveredViaSendMessage,
  sentSomething,
  startedJob,
  toolCalled,
  toolNotCalled,
} from '../graders.js';
import type { EvalCase } from '../types.js';

/**
 * Tool selection (task 8.4): the appropriate tool is chosen for a request — a
 * durable job for async research (after an "on it" send), scheduling for a timed
 * reminder, and NO heavyweight tool for a trivial greeting. Graded on the tool
 * calls in the trajectory (the recording fake `start` means `start_job` is
 * observed, not launched).
 */
export const toolSelectionCases: EvalCase[] = [
  {
    name: 'tool-selection/research-starts-job',
    dimension: 'tool-selection',
    input: 'research the best noise-cancelling headphones under $300 and report back',
    graders: [sentSomething, startedJob],
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
      deliveredViaSendMessage,
      toolNotCalled('start_job'),
      toolNotCalled('schedule_create'),
    ],
  },
];
