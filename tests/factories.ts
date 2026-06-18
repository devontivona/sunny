import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UIMessage } from 'ai';
import { ConfigSchema, type SunnyConfig } from '../src/config/index.js';
import type { ChannelEvent } from '../src/gateway/types.js';
import type { ConversationStore, StoredMessage } from '../src/gateway/store.js';
import { applyMemoryWrite, type MemoryWriteInput } from '../src/memory/index.js';

/**
 * Typed object-mother builders (design D15 / task 2.7). Deterministic defaults +
 * explicit per-test overrides — NO faker. The assertions in this suite check
 * specific values (phone normalization, FTS tokens, exact tool calls), so random
 * data would fight them; a shape change updates this one module. Memory and
 * conversation setup seed through the REAL write APIs so format drift is caught.
 */

/** The owner's canonical test identity (matches `makeChannelEvent` defaults). */
export const OWNER_PHONE = '+15551230000';
export const OWNER_THREAD = 'sendblue:owner:contact';
export const GROUP_THREAD = 'sendblue:owner:g:group1';

/** Deterministic counter for rare bulk filler (`msg-1`, `msg-2`, …) — never random. */
let seq = 0;
export function nextId(prefix = 'msg'): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** A fresh, isolated runtime dir under the OS temp dir (for memory seeds). */
export function tempRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), 'sunny-test-'));
}

export function makeConfig(overrides: Partial<SunnyConfig> = {}): SunnyConfig {
  const { runtimeDir, ...rest } = overrides;
  const parsed = ConfigSchema.parse({
    owner: { name: 'Devon', identities: [OWNER_PHONE] },
    ...rest,
  });
  return { ...parsed, runtimeDir: runtimeDir ?? tempRuntimeDir() };
}

export function makeChannelEvent(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
  return {
    channel: 'imessage',
    threadId: OWNER_THREAD,
    messageId: nextId('in'),
    senderId: OWNER_PHONE,
    senderName: 'Devon',
    text: 'hey sunny',
    attachments: [],
    timestamp: new Date('2026-01-01T12:00:00.000Z'),
    isGroup: false,
    isOwner: true,
    ...overrides,
  };
}

export function makeStoredMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    messageId: nextId('stored'),
    threadId: OWNER_THREAD,
    role: 'user',
    senderId: OWNER_PHONE,
    senderName: 'Devon',
    text: 'hey sunny',
    payload: null,
    timestamp: new Date('2026-01-01T12:00:00.000Z'),
    isOwner: true,
    ...overrides,
  };
}

/** A user `UIMessage` payload (D-MG9): one text part. */
export function makeUserPayload(text: string, id = nextId('u')): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/**
 * An assistant turn `UIMessage` payload (D-MG9): optional private scratch text
 * plus a `send_message` tool part per delivered bubble — the same shape the loop
 * persists, so window/conversion tests run against the real format.
 */
export function makeAssistantTurnPayload(opts: {
  scratch?: string;
  sends?: string[];
  id?: string;
}): UIMessage {
  const id = opts.id ?? nextId('a');
  const parts: UIMessage['parts'] = [];
  if (opts.scratch) parts.push({ type: 'text', text: opts.scratch });
  (opts.sends ?? []).forEach((text, i) => {
    parts.push({
      type: 'tool-send_message',
      toolCallId: `send-${id}-${i}`,
      state: 'output-available',
      input: { text },
      output: 'delivered',
    } as UIMessage['parts'][number]);
  });
  return { id, role: 'assistant', parts };
}

/** Seed the memory core through the REAL write API (D15 — catches format drift). */
export async function seedMemory(config: SunnyConfig, writes: MemoryWriteInput[]): Promise<void> {
  for (const w of writes) await applyMemoryWrite(config, w);
}

/** Seed inbound messages through the REAL store API, in order. */
export async function seedInbound(store: ConversationStore, events: ChannelEvent[]): Promise<void> {
  for (const e of events) await store.appendInbound(e);
}
