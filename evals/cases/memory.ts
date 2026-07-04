import { deliveredReply, memoryWritten, replyMentions, toolCalled } from '../graders.js';
import { rubricJudge } from '../judge.js';
import type { EvalCase } from '../types.js';

/**
 * Memory recall (task 8.3): a seeded `USER.md` fact is used in a reply; a told
 * durable fact is recorded via `memory_write` to USER; a seeded archive (outside
 * the recent window) is recalled via `recall_history` and used — graded
 * programmatically plus one judge for natural use.
 */
export const memoryCases: EvalCase[] = [
  {
    name: 'memory/uses-seeded-user-fact',
    dimension: 'memory',
    setup: {
      memory: [{ file: 'USER', action: 'add', content: '- Allergic to peanuts' }],
    },
    input: 'is it safe for me to eat a Snickers bar?',
    graders: [deliveredReply, replyMentions('peanut')],
  },
  {
    name: 'memory/records-durable-fact',
    dimension: 'memory',
    input: "for the record, my wife's name is Mara",
    graders: [memoryWritten('USER', /mara/i)],
  },
  {
    name: 'memory/recalls-archive',
    dimension: 'memory',
    setup: {
      // A tiny recent window pushes the seeded archive out, forcing a recall.
      config: { recentWindowSize: 1 },
      conversation: [
        { role: 'user', text: 'my favorite hike is the Precipice Trail in Acadia' },
        { role: 'assistant', text: 'noted!' },
      ],
    },
    input: 'what was that hike I mentioned to you a while back?',
    graders: [
      toolCalled('recall_history'),
      replyMentions('Precipice'),
      rubricJudge({
        name: 'natural-recall',
        question:
          'Does the reply recall the earlier hike naturally and helpfully (not robotically)?',
      }),
    ],
  },
];
