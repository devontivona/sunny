import { anthropic } from '@ai-sdk/anthropic';
import type { SteerHandle } from '../src/agent/dispatcher.js';
import { classifyDelivery } from '../src/agent/turn.js';
import { createTestDb } from '../tests/db.js';
import { createTestRuntime } from '../tests/harness.js';
import { makeChannelEvent, makeConfig, seedMemory, OWNER_THREAD } from '../tests/factories.js';
import type { EvalCase, ToolCallRecord, Trajectory } from './types.js';

const NO_STEER: SteerHandle = { drain: () => [] };

/** The production model under test by default (design D14 — "practice like we play"). */
export const DEFAULT_MODEL_ID = 'claude-opus-4-8';

/**
 * Behavioral eval harness (task 7.1 / agent-evals spec).
 *
 * Drives the REAL agent loop for a case against the fake gateway + the recording
 * fake durable-`start`, with a real model selected by `modelId` (default the
 * production Opus). It seeds the case's memory/conversation through the real
 * write APIs, runs the input turn(s), and returns the captured trajectory —
 * tool calls, sends, `delivered`, started jobs — for the graders to read.
 *
 * No DI is needed for the model here (evals use a real one); only the durable
 * `start` is faked so a tool-selection case can grade that the model *chose*
 * `start_job` without launching a durable run.
 */
export async function runEvalCase(c: EvalCase, modelId = DEFAULT_MODEL_ID): Promise<Trajectory> {
  const tdb = await createTestDb();
  try {
    const config = makeConfig({ modelId, ...c.setup?.config });
    await seedMemory(config, c.setup?.memory ?? []);

    const rt = createTestRuntime({ db: tdb.db, model: anthropic(modelId), config });

    // Seed prior conversation through the real store (so format drift is caught).
    let n = 0;
    for (const seed of c.setup?.conversation ?? []) {
      n += 1;
      if (seed.role === 'user') {
        await rt.store.appendInbound(
          makeChannelEvent({
            threadId: OWNER_THREAD,
            messageId: `seed-${n}`,
            text: seed.text,
            senderName: seed.senderName ?? 'Devon',
            isOwner: c.setup?.isOwner ?? true,
            isGroup: c.setup?.isGroup ?? false,
          }),
        );
      } else {
        await rt.store.appendOutbound(OWNER_THREAD, `seed-${n}`, seed.text);
      }
    }

    const inputs = Array.isArray(c.input) ? c.input : [c.input];
    let lastMessageId = '';
    for (let i = 0; i < inputs.length; i++) {
      const ev = makeChannelEvent({
        threadId: OWNER_THREAD,
        messageId: `input-${i + 1}`,
        text: inputs[i]!,
        isOwner: c.setup?.isOwner ?? true,
        isGroup: c.setup?.isGroup ?? false,
      });
      await rt.store.appendInbound(ev);
      await rt.runTurn(ev, NO_STEER);
      lastMessageId = ev.messageId;
    }

    // MUST `await` here: with a bare `return buildTrajectory(...)`, the `finally`
    // teardown runs while buildTrajectory's `recentWindow` query is still in
    // flight — closing the DB mid-query (which wedges PGlite's single connection).
    return await buildTrajectory(rt, lastMessageId);
  } finally {
    await tdb.teardown();
  }
}

/** Reconstruct the trajectory from the last persisted turn + the fakes. */
async function buildTrajectory(
  rt: ReturnType<typeof createTestRuntime>,
  _lastMessageId: string,
): Promise<Trajectory> {
  const window = await rt.store.recentWindow(OWNER_THREAD);
  const lastTurn = [...window].reverse().find((m) => m.role === 'assistant');
  const payload = (lastTurn?.payload ?? { parts: [], metadata: {} }) as {
    parts: Array<{ type: string; input?: unknown; text?: string }>;
    metadata?: {
      delivered?: Trajectory['delivered'];
      usage?: { in?: number | null; out?: number | null; cached?: number | null };
    };
  };

  const toolCalls: ToolCallRecord[] = payload.parts
    .filter((p) => p.type.startsWith('tool-'))
    .map((p) => ({ name: p.type.slice('tool-'.length), input: p.input }));
  const scratch = payload.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();

  const sends = rt.gateway.texts();
  const delivered = payload.metadata?.delivered ?? classifyDelivery(rt.gateway.sendCount, scratch);
  const u = payload.metadata?.usage;

  return {
    toolCalls,
    sends,
    delivered,
    startJobs: rt.fakeStart.calls,
    finalText: sends.join('\n'),
    scratch,
    usage: {
      inputTokens: u?.in ?? 0,
      outputTokens: u?.out ?? 0,
      cachedInputTokens: u?.cached ?? 0,
    },
  };
}
