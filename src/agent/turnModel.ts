import type { LanguageModel } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { anthropic } from '@ai-sdk/anthropic';
import { mockSequenceModel, type MockResponseDescriptor } from './mockModel.js';
import { ObservedLanguageModel, type ObserveMeta } from './observedModel.js';

export type { MockResponseDescriptor, ObserveMeta };

/** Test seam key: a workflow integration test sets an array of mock response descriptors
 *  (plain, serializable data) here on `globalThis`. */
const TEST_TURN_MODEL = Symbol.for('sunny.testTurnModel');

/**
 * The conversational turn's model factory (durable-main-loop, AI SDK v7 / `WorkflowAgent`).
 * Production returns the real Anthropic provider INSTANCE; `WorkflowAgent` journals it across
 * the `doStreamStep` boundary via the WDK class-serialization protocol the v7 providers
 * implement (`@ai-sdk/anthropic`'s `AnthropicLanguageModel` has `WORKFLOW_SERIALIZE`/
 * `WORKFLOW_DESERIALIZE`), so no gateway and no shim are needed.
 *
 * A `@workflow/vitest` integration test scripts the turn by setting mock RESPONSES (not the
 * model itself) on `globalThis[TEST_TURN_MODEL_KEY]`; `setupTurn` reads them with {@link
 * testModelResponses} (in a step, where the global is visible) and threads them to this builder,
 * which runs in the workflow body to construct the mock. We pass plain data through the step
 * boundary because the responses are serializable; the mock model itself is made serializable by
 * {@link SerializableMockModel} (mock instances are otherwise non-serializable closures).
 *
 * Node-free (only `@ai-sdk/anthropic` + the serializable mock + a type import), so it is safe to
 * import from the workflow, matching `bashSpecs`/`memorySpecs`.
 *
 * `observe` wraps the model (real OR mock — tests exercise the same serialization + span path)
 * in {@link ObservedLanguageModel}, which emits one exactly-once generation span per model call
 * from the host side of the journaled `doStreamStep` — the durable runs' Langfuse telemetry
 * (see observedModel.ts for why the WorkflowAgent's own telemetry can't reach the exporter).
 */
export function buildTurnModel(
  modelId: string,
  responses?: MockResponseDescriptor[],
  observe?: ObserveMeta,
): LanguageModel {
  const inner =
    responses && responses.length > 0
      ? (mockSequenceModel(responses) as unknown as LanguageModelV4)
      : anthropic(modelId);
  return observe ? new ObservedLanguageModel(inner, observe) : inner;
}

/**
 * The mock responses scripted for a turn, or undefined in production. Read in a STEP (the workflow
 * body runs in an isolated context where a `globalThis` override is NOT visible).
 *
 * Two shapes share the key: a `Map<threadId, responses>` set per-thread ({@link
 * setTestModelResponses}, used by the loopback test channel so a mock only ever drives its OWN
 * thread — never a real iMessage thread), or a legacy plain ARRAY set directly by the
 * `@workflow/vitest` harness (single-turn, no concurrency → no keying needed).
 *
 * The per-thread entry PERSISTS until explicitly cleared/overwritten — NOT consumed once — so it
 * reliably drives every turn on the test thread regardless of backlog/drain/divergence-retry
 * ordering (a one-shot mock could be eaten by an unrelated turn before the intended one ran).
 * Clearing is the route's job (an inject with no `modelResponses`).
 */
export function testModelResponses(threadId?: string): MockResponseDescriptor[] | undefined {
  const v = (globalThis as Record<symbol, unknown>)[TEST_TURN_MODEL];
  if (v instanceof Map) {
    if (!threadId) return undefined;
    return v.get(threadId) as MockResponseDescriptor[] | undefined;
  }
  return Array.isArray(v) ? (v as MockResponseDescriptor[]) : undefined;
}

/**
 * Script (or clear) the turns on `threadId` with mock responses — keyed per-thread and read by
 * {@link testModelResponses}. Persists until overwritten; an empty/absent `responses` clears the
 * thread's entry (→ the real model). Used by the loopback `/test/inbound` route.
 */
export function setTestModelResponses(
  threadId: string,
  responses: MockResponseDescriptor[] | undefined,
): void {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[TEST_TURN_MODEL];
  if (!(map instanceof Map)) {
    map = new Map<string, MockResponseDescriptor[]>();
    g[TEST_TURN_MODEL] = map;
  }
  if (responses && responses.length > 0) (map as Map<string, unknown>).set(threadId, responses);
  else (map as Map<string, unknown>).delete(threadId);
}

/** The `globalThis` key a test sets to script the turn model (see {@link testModelResponses}). */
export const TEST_TURN_MODEL_KEY = TEST_TURN_MODEL;
