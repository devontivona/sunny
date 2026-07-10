import { tool } from 'ai';
import type { SunnyConfig } from '../../config/index.js';
import type { ConversationStore, StoredMessage } from '../../gateway/store.js';
import { normalize } from '../../gateway/auth.js';
import { attachmentRefsOf } from '../../gateway/media.js';
import {
  applyMemoryWrite,
  MemoryOverflowError,
  memoryPaths,
  readTopic,
  type MemoryWriteInput,
} from '../../memory/index.js';
import { stripBinaryRuns, stringifyToolValue } from '../delivery.js';
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
 *
 * Recall v2 (context-lifecycle): each hit is a match SNIPPET (never the whole stored row —
 * the projection now carries tool-result extracts), tagged with the message id for
 * `recall_expand`, plus each attachment's name and saved disk path so an old file can be
 * re-read instead of re-requested.
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
      const snippet = m.snippet.replace(/\s+/g, ' ').trim() || m.text.slice(0, 200);
      const head = `[${m.timestamp.toISOString().slice(0, 10)}] ${who} (in ${where}) [id:${m.messageId}]: ${snippet}`;
      return [head, ...attachmentLines(m)].join('\n');
    })
    .join('\n');
}

/** Rendered attachment lines for a stored row (name + saved disk path — files persist
 *  forever, so a hit's attachment is always one file_read away). */
function attachmentLines(m: StoredMessage): string[] {
  return attachmentRefsOf(m.payload).map((ref) =>
    ref.path && !ref.error
      ? `    attachment: ${ref.name} (${ref.mediaType}) — saved at ${ref.path}`
      : `    attachment: ${ref.name} (${ref.mediaType}) — not saved${ref.error ? ` (${ref.error})` : ''}`,
  );
}

/** Cap for one expanded row (context-lifecycle recall v2 — fetch deeply, but bounded). */
const RECALL_EXPAND_MAX_CHARS = 20_000;

/**
 * Deep-fetch ONE stored message in full by the id a recall snippet showed
 * (context-lifecycle recall v2): the spoken/narration text, this turn's tool calls with
 * their (binary-stripped) outputs, and each attachment's name + saved path. Length-capped.
 */
export async function execRecallExpand(
  store: ConversationStore,
  config: SunnyConfig,
  messageId: string,
): Promise<string> {
  const m = await store.messageById(messageId);
  if (!m) return `(no stored message with id "${messageId}" — use the id shown by recall_history)`;
  const who = m.role === 'assistant' ? 'Sunny' : (m.senderName ?? m.senderId);
  const where = labelForThread(config, m.threadId);
  const header = `[${m.timestamp.toISOString()}] ${who} (in ${where}) [id:${m.messageId}]`;
  const body = renderFullRow(m);
  const out = `${header}\n${body}`;
  return out.length > RECALL_EXPAND_MAX_CHARS
    ? `${out.slice(0, RECALL_EXPAND_MAX_CHARS)}\n…(truncated at ${RECALL_EXPAND_MAX_CHARS} chars)`
    : out;
}

/** Render a stored row in full from its rich payload (falls back to the flat text
 *  projection for legacy rows with no payload). */
function renderFullRow(m: StoredMessage): string {
  const parts = (m.payload as { parts?: Array<Record<string, unknown>> } | null)?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return m.text;
  const lines: string[] = [];
  for (const p of parts) {
    const type = typeof p.type === 'string' ? p.type : '';
    if (type === 'text' && typeof p.text === 'string' && p.text.trim()) {
      lines.push(p.text.trim());
    } else if (type === 'data-attachment') {
      const ref = p.data as { name?: string; mediaType?: string; path?: string | null } | undefined;
      if (ref) {
        lines.push(
          ref.path
            ? `attachment: ${ref.name} (${ref.mediaType}) — saved at ${ref.path}`
            : `attachment: ${ref.name} (${ref.mediaType}) — not saved`,
        );
      }
    } else if (type === 'data-translator') {
      const d = p.data as { text?: string } | undefined;
      if (d?.text) lines.push(`[progress update relayed: "${d.text}"]`);
    } else if (type === 'data-delivery-failure') {
      const d = p.data as { note?: string } | undefined;
      if (d?.note) lines.push(`[DELIVERY FAILURE: ${d.note}]`);
    } else if (type.startsWith('tool-')) {
      const name = type.slice('tool-'.length);
      const input = stripBinaryRuns(stringifyToolValue(p.input)).slice(0, 500);
      const output = stripBinaryRuns(stringifyToolValue(p.output)).slice(0, 4000);
      lines.push(`[tool ${name}] input: ${input}${output ? `\n  output: ${output}` : ''}`);
    }
  }
  return lines.join('\n') || m.text;
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
    recall_expand: tool({
      ...MEMORY_TOOL_SPECS.recall_expand,
      execute: ({ messageId }) => execRecallExpand(store, config, messageId),
    }),
  };
}
