import { tool } from 'ai';
import type { SunnyConfig } from '../../config/index.js';
import type { ConversationStore } from '../../gateway/store.js';
import { normalize } from '../../gateway/auth.js';
import {
  applyMemoryWrite,
  MemoryOverflowError,
  memoryPaths,
  readTopic,
  type MemoryWriteInput,
} from '../../memory/index.js';
import { MEMORY_TOOL_SPECS } from './memorySpecs.js';

export { MEMORY_TOOL_SPECS };

/** Apply a memory write, returning a result/error string (never throws). */
export async function execMemoryWrite(
  config: SunnyConfig,
  input: MemoryWriteInput,
): Promise<string> {
  try {
    return await applyMemoryWrite(config, input);
  } catch (err) {
    if (err instanceof MemoryOverflowError) return `ERROR (overflow): ${err.message}`;
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Read a topic doc by name, or a not-found message. */
export function execReadTopic(config: SunnyConfig, name: string): string {
  const content = readTopic(memoryPaths(config.runtimeDir), name);
  return content ?? `(no topic doc named "${name}")`;
}

/**
 * Keyword-recall older messages across ALL conversations (multiplayer-family: cross-thread
 * recall), formatted for the model to summarize. Each hit is attributed with WHO said it and
 * WHICH conversation it was in, so Sunny can cross-reference (e.g. "in your chat with Kate…").
 */
export async function execRecall(
  store: ConversationStore,
  config: SunnyConfig,
  query: string,
  limit?: number,
): Promise<string> {
  const hits = await store.recall(query, limit ?? 10);
  if (hits.length === 0) return `(no past messages match "${query}")`;
  return hits
    .map((m) => {
      const who = m.role === 'assistant' ? 'Sunny' : (m.senderName ?? m.senderId);
      const where = labelForThread(config, m.threadId);
      return `[${m.timestamp.toISOString().slice(0, 10)}] ${who} (in ${where}): ${m.text}`;
    })
    .join('\n');
}

/**
 * A human label for a thread, so recall hits read as "in your chat with Kate" rather than an
 * opaque id. Resolves a Sendblue DM's contact number against the owner/family roster; groups and
 * unknown threads get a generic label. Best-effort — never throws.
 */
function labelForThread(config: SunnyConfig, threadId: string): string {
  const parts = threadId.split(':');
  if (parts[0] !== 'sendblue') return 'another conversation';
  if (parts[2] === 'g') return 'a group chat';
  let number = '';
  try {
    number = Buffer.from(parts[2] ?? '', 'base64url').toString('utf8');
  } catch {
    number = '';
  }
  if (!number) return 'another conversation';
  const norm = normalize(number);
  if (config.owner.identities.map(normalize).includes(norm)) {
    return `the chat with ${config.owner.name}`;
  }
  for (const p of config.family) {
    if (p.identities.map(normalize).includes(norm)) return `the chat with ${p.name}`;
  }
  return `the chat with ${number}`;
}

/**
 * Memory tools (agent-memory): a write tool with add/replace/remove and no read
 * (D2 — the core is already in context), on-demand topic-doc reads (D1/D3), and
 * keyword recall over the message archive (D5 upgrade path). All writes funnel
 * through the serialized writer (R7).
 */
export function createMemoryTools(config: SunnyConfig, store: ConversationStore) {
  return {
    memory_write: tool({
      ...MEMORY_TOOL_SPECS.memory_write,
      execute: (input: MemoryWriteInput) => execMemoryWrite(config, input),
    }),
    read_topic: tool({
      ...MEMORY_TOOL_SPECS.read_topic,
      execute: ({ name }) => Promise.resolve(execReadTopic(config, name)),
    }),
    recall_history: tool({
      ...MEMORY_TOOL_SPECS.recall_history,
      execute: ({ query, limit }) => execRecall(store, config, query, limit),
    }),
  };
}
