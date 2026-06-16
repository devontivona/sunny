import { tool } from 'ai';
import { z } from 'zod';
import type { SunnyConfig } from '../../config/index.js';
import type { ConversationStore } from '../../gateway/store.js';
import {
  applyMemoryWrite,
  MemoryOverflowError,
  memoryPaths,
  readTopic,
  type MemoryWriteInput,
} from '../../memory/index.js';

/**
 * Memory tools (agent-memory): a write tool with add/replace/remove and no read
 * (D2 — the core is already in context), on-demand topic-doc reads (D1/D3), and
 * keyword recall over the message archive (D5 upgrade path). All writes funnel
 * through the serialized writer (R7).
 */
export function createMemoryTools(config: SunnyConfig, store: ConversationStore) {
  const paths = memoryPaths(config.runtimeDir);

  const memory_write = tool({
    description:
      'Record durable memory. Use for facts worth remembering across conversations. ' +
      'file: "USER" (facts about the user), "SUNNY" (your own operating notes), ' +
      '"INDEX" (one line per topic doc), or "topic:<name>" (deeper, unbounded notes). ' +
      'action: "add" appends content; "replace" swaps `target` for `content` (or, with no ' +
      'target, rewrites the whole file — use to consolidate); "remove" deletes `target`. ' +
      'Core files (USER/SUNNY/INDEX) are capped: if a write overflows you get an error — ' +
      'consolidate (prune or move detail into a topic doc, add an INDEX line) and retry. ' +
      'Put facts that change over time in topic docs with date-range tags, e.g. ' +
      '"[2025-06 → present] founder, Tivona".',
    inputSchema: z.object({
      file: z.string().describe('"USER" | "SUNNY" | "INDEX" | "topic:<name>"'),
      action: z.enum(['add', 'replace', 'remove']),
      content: z.string().optional().describe('Text to add, full replacement body, or new text.'),
      target: z.string().optional().describe('Existing substring to replace/remove.'),
    }),
    execute: async (input: MemoryWriteInput) => {
      try {
        return await applyMemoryWrite(config, input);
      } catch (err) {
        if (err instanceof MemoryOverflowError) return `ERROR (overflow): ${err.message}`;
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  const read_topic = tool({
    description:
      'Read a topic document (deeper memory) listed in INDEX. Use when the conversation ' +
      'relates to a topic you see in the INDEX router. Returns the topic markdown.',
    inputSchema: z.object({
      name: z.string().describe('Topic name as listed in INDEX (e.g. "work").'),
    }),
    execute: async ({ name }) => {
      const content = readTopic(paths, name);
      return content ?? `(no topic doc named "${name}")`;
    },
  });

  const recall_history = tool({
    description:
      'Search older message history by keyword when something is beyond the recent window. ' +
      'Returns matching past messages (newest first) for you to summarize. Use sparingly.',
    inputSchema: z.object({
      query: z.string().describe('Keywords to search for in past messages.'),
      limit: z.number().int().positive().max(25).optional(),
    }),
    execute: async ({ query, limit }) => {
      const hits = await store.recall(query, limit ?? 10);
      if (hits.length === 0) return `(no past messages match "${query}")`;
      return hits
        .map((m) => {
          const who = m.role === 'assistant' ? 'Sunny' : (m.senderName ?? m.senderId);
          return `[${m.timestamp.toISOString().slice(0, 10)}] ${who}: ${m.text}`;
        })
        .join('\n');
    },
  });

  return { memory_write, read_topic, recall_history };
}
