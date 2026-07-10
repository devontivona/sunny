import { z } from 'zod';

/**
 * Memory tool specs (description + input schema), shared by the in-process agent
 * tools (`createMemoryTools`) and the durable scheduled-job tools. Kept **Node-free**
 * (zod only) on purpose: it is imported at the workflow level to build the
 * `DurableAgent` tools, and workflow code runs in a sandbox where Node modules
 * (`node:fs`, etc.) are unavailable. The tool `execute` logic — which does touch
 * the filesystem/DB — lives in `memory.ts` and is invoked from `"use step"` units.
 */
export const MEMORY_TOOL_SPECS = {
  memory_write: {
    description:
      'Record durable memory. Use for facts worth remembering across conversations. ' +
      'file: "USER" (facts about the owner), "SUNNY" (your own operating notes), ' +
      '"INDEX" (one line per topic doc), "people:<id>" (facts about a specific family member — ' +
      'use the handle shown for them in the PEOPLE block), or "topic:<name>" (deeper notes). ' +
      'action: "add" appends content; "replace" swaps `target` for `content` (or, with no ' +
      'target, rewrites the whole file — use to consolidate); "remove" deletes `target`. ' +
      'Core files (USER/SUNNY/INDEX) are capped: if a write overflows you get an error — ' +
      'consolidate (prune or move detail into a topic doc, add an INDEX line) and retry. ' +
      'Put facts that change over time in topic docs with date-range tags, e.g. ' +
      '"[2025-06 → present] founder, Tivona".',
    inputSchema: z.object({
      file: z.string().describe('"USER" | "SUNNY" | "INDEX" | "topic:<name>"'),
      action: z
        .enum(['add', 'replace', 'remove'])
        .describe(
          'add appends content · replace swaps `target` for `content` (or, with no target, ' +
            'rewrites the whole file) · remove deletes `target`.',
        ),
      content: z.string().optional().describe('Text to add, full replacement body, or new text.'),
      target: z.string().optional().describe('Existing substring to replace/remove.'),
    }),
  },
  read_topic: {
    description:
      'Read a topic document (deeper memory) listed in INDEX. Use when the conversation ' +
      'relates to a topic you see in the INDEX router. Returns the topic markdown.',
    inputSchema: z.object({
      name: z.string().describe('Topic name as listed in INDEX (e.g. "work").'),
    }),
  },
  recall_history: {
    description:
      'Search past message history by keyword across ALL conversations — every thread, not just ' +
      "this one (the owner's and family members' chats alike). The search covers what was SAID " +
      'and what past turns READ in tool output (emails, documents, fetched pages). Use it to ' +
      'recall things beyond the recent window OR to cross-reference another conversation (e.g. ' +
      "someone mentions a person or event you don't see here). Returns match SNIPPETS (newest " +
      'first), each attributed with who/which chat, its [id:…], and any attachment names + saved ' +
      'file paths. For the full message behind a load-bearing snippet, call recall_expand with ' +
      "its id. Use discretion about repeating one person's private remarks to another.",
    inputSchema: z.object({
      query: z.string().describe('Keywords to search for in past messages.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(25)
        .optional()
        .describe('Max messages to return (default 10, max 25).'),
    }),
  },
  recall_expand: {
    description:
      'Fetch ONE past message in full by the [id:…] a recall_history snippet showed: the ' +
      'complete text, the tool calls that turn made with their outputs, and any attachment ' +
      'names + saved file paths. Use when a snippet looks load-bearing and you need the detail ' +
      'behind it (length-capped; one message per call).',
    inputSchema: z.object({
      messageId: z.string().describe('The message id shown in a recall_history hit ([id:…]).'),
    }),
  },
};
