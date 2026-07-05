import { asSchema } from '@ai-sdk/provider-utils';
import type { Db } from '../../db/client.js';
import type { ConversationStore } from '../../gateway/store.js';
import type { SunnyConfig } from '../../config/index.js';
import { SEND_IMAGE_SPEC } from './sendMessageSpec.js';
import { START_JOB_SPEC } from './startJobSpec.js';
import { createScheduleTools } from './schedule.js';
import { RUNS_TOOL_SPECS } from './scheduleSpecs.js';
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
 * The catalog is built from the SAME tool factories the durable conversational turn
 * registers (`workflows/conversation.ts` `buildTools`), so a tool added there — or a
 * description edit — surfaces here automatically. The factories are constructed with inert
 * deps (gateway/db/store are only captured in `execute` closures, never touched at
 * construction); nothing is executed — we only read each tool's `description`.
 * The "elevated" grouping mirrors the turn's trusted-DM gate (`trustedDm` — owner OR family,
 * never a group; host/registry/scheduling/delegation tools); it is inherent policy, not derived.
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
  // v7 widened a tool's `description` to `string | ((options) => string)`; the catalog only
  // reads static string descriptions (purposeOf guards non-strings).
  description?: string | ((options: never) => string);
  inputSchema?: unknown;
}

/** Derive the input parameters from a tool's schema (observe-only; the same schema the model is
 *  given). Uses the SDK's `asSchema`, so it works for both zod schemas and hand-authored
 *  `jsonSchema()` schemas (e.g. bash, whose provider schema is hand-authored to dodge the v7
 *  `z.record` conversion bug). Best-effort — an odd schema yields []. */
function paramsOf(inputSchema: unknown): ToolParam[] {
  if (!inputSchema) return [];
  try {
    const js = asSchema(inputSchema as Parameters<typeof asSchema>[0]).jsonSchema as {
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
function purposeOf(description: string | ((options: never) => string) | undefined): string {
  const oneLine = (typeof description === 'string' ? description : '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  const sentence = /^(.*?[.!?])(\s|$)/.exec(oneLine)?.[1]?.trim() ?? oneLine;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

export function toolCatalog(config: SunnyConfig): ToolCatalogEntry[] {
  // Inert deps — construction never reads these; we only read tool metadata.
  const inertDb = undefined as unknown as Db;
  const inertStore = undefined as unknown as ConversationStore;

  // Mirror `conversation.ts` `buildTools` (text-as-reply, PR #31: the reply is the model's
  // final text — no send_message/stay_silent tools). `send_image`/`start_job`/memory are
  // registered on every turn; scheduling/credentials/mcp/host tools are trusted-DM-only
  // (owner OR family).
  const broad: Record<string, ToolLike> = {
    send_image: SEND_IMAGE_SPEC,
    start_job: START_JOB_SPEC,
    ...createMemoryTools(config, inertStore),
  };
  const ownerOnly: Record<string, ToolLike> = {
    ...createScheduleTools(inertDb, '', config.timezone),
    ...RUNS_TOOL_SPECS,
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
