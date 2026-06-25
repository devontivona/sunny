import { z } from 'zod';
import type { Gateway } from '../../gateway/types.js';
import type { Db } from '../../db/client.js';
import type { ConversationStore } from '../../gateway/store.js';
import type { SunnyConfig } from '../../config/index.js';
import { createSendMessageTool } from './sendMessage.js';
import { createStaySilentTool } from './staySilent.js';
import { createStartJobTool } from './startJob.js';
import { createScheduleTools } from './schedule.js';
import { createCredentialTools } from './credentialManage.js';
import { createMcpTools } from './mcpManage.js';
import { createBashTools } from './bash.js';
import { createMemoryTools } from './memory.js';

/**
 * Read-only tool catalog for the dashboard (web-dashboard; the introspection
 * residual of D-TA0 — "a read-only tool catalog (name + purpose + owner-gated),
 * derivable from the registered tools"). It is observe-only metadata, NOT an
 * enforcement seam: gating lives at the command/action/credential layers.
 *
 * The catalog is built from the SAME tool factories the turn loop registers
 * (`src/agent/loop.ts`), so a tool added to a factory — or a description edit —
 * surfaces here automatically. The factories are constructed with inert deps
 * (gateway/db/store are only captured in `execute` closures, never touched at
 * construction); nothing is executed — we only read each tool's `description`.
 * The owner-only grouping mirrors the loop's `event.isOwner && !event.isGroup`
 * gate (host/registry/scheduling tools); it is inherent policy, not derived.
 */

export interface ToolParam {
  name: string;
  /** JSON-schema type (string/number/object/…), or 'any' if not expressible. */
  type: string;
  required: boolean;
  description?: string;
}

export interface ToolCatalogEntry {
  name: string;
  /** One-line purpose, distilled from the tool's model-facing description. */
  purpose: string;
  /** True when the tool is only registered on owner DMs (the loop's gate). */
  ownerOnly: boolean;
  /** Input parameters, derived from the tool's zod `inputSchema`. */
  params: ToolParam[];
}

interface ToolLike {
  description?: string;
  inputSchema?: unknown;
}

/** Derive the input parameters from a tool's zod schema (observe-only; the same
 *  schema the model is given). Best-effort — a non-zod/odd schema yields []. */
function paramsOf(inputSchema: unknown): ToolParam[] {
  if (!inputSchema) return [];
  try {
    const js = z.toJSONSchema(inputSchema as Parameters<typeof z.toJSONSchema>[0]) as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    const required = new Set(js.required ?? []);
    return Object.entries(js.properties ?? {}).map(([name, p]) => ({
      name,
      type: typeof p.type === 'string' ? p.type : 'any',
      required: required.has(name),
      ...(p.description ? { description: p.description } : {}),
    }));
  } catch {
    return [];
  }
}

/** Distill a model-facing description into a one-line directory purpose: the
 *  first sentence, whitespace-collapsed and length-capped. */
function purposeOf(description: string | undefined): string {
  const oneLine = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  const sentence = /^(.*?[.!?])(\s|$)/.exec(oneLine)?.[1]?.trim() ?? oneLine;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

export function toolCatalog(config: SunnyConfig): ToolCatalogEntry[] {
  // Inert per-turn state + deps — construction never reads these; we only read
  // tool metadata. Cast through `undefined` for the deps used solely in closures.
  const counter = { count: 0 };
  const silence = { silent: false };
  const inertGateway = undefined as unknown as Gateway;
  const inertDb = undefined as unknown as Db;
  const inertStore = undefined as unknown as ConversationStore;

  // Mirror loop.ts assembly. `send_message`/`stay_silent`/`start_job`/memory are
  // registered on every turn; scheduling/credentials/mcp/host tools are owner-DM-only.
  const broad: Record<string, ToolLike> = {
    send_message: createSendMessageTool(inertGateway, '', counter),
    stay_silent: createStaySilentTool(silence),
    start_job: createStartJobTool('', config.owner.name),
    ...createMemoryTools(config, inertStore),
  };
  const ownerOnly: Record<string, ToolLike> = {
    ...createScheduleTools(inertDb, '', config.timezone),
    ...createCredentialTools(config, undefined),
    ...createMcpTools(config, undefined),
    ...createBashTools(config, undefined),
  };

  const entries: ToolCatalogEntry[] = [
    ...Object.entries(broad).map(([name, t]) => ({
      name,
      purpose: purposeOf(t.description),
      ownerOnly: false,
      params: paramsOf(t.inputSchema),
    })),
    ...Object.entries(ownerOnly).map(([name, t]) => ({
      name,
      purpose: purposeOf(t.description),
      ownerOnly: true,
      params: paramsOf(t.inputSchema),
    })),
  ];
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
