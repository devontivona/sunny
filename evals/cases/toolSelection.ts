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
 * calls in the trajectory (the recording fake `start` means `start_job` is
 * observed, not launched).
 */
export const toolSelectionCases: EvalCase[] = [
  {
    name: 'tool-selection/research-starts-job',
    dimension: 'tool-selection',
    input: 'research the best noise-cancelling headphones under $300 and report back',
    // Regraded 2026-07-04 (text-delivery Phase 6): the POLICY is "background long work,
    // keep the thread responsive" — start_job or delegate_task both satisfy it (both are
    // durable and report back); grinding inline with dozens of calls violates it even if
    // the eventual answer is good. The tool-mode baseline (5/5 via start_job) still
    // passes under this grader.
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
      toolNotCalled('start_job'),
      toolNotCalled('schedule_create'),
    ],
  },
];
