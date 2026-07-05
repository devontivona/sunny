import { mkdirSync, writeFileSync } from 'node:fs';
import { start } from 'workflow/api';
import { runConversation } from '../workflows/conversation.js';
import { ConversationStore } from '../src/gateway/store.js';
import {
  classifyTextDelivery,
  extractFinalText,
  extractInterimText,
  extractTranslatorUpdates,
  stripNoReply,
} from '../src/agent/turn.js';
import type { UIMessage } from 'ai';
import { initMemory, memoryPaths } from '../src/memory/index.js';
import { createTestDb } from '../tests/db.js';
import { FakeGateway } from '../tests/fakes/gateway.js';
import {
  makeAssistantTurnPayload,
  makeChannelEvent,
  makeConfig,
  seedMemory,
  OWNER_THREAD,
} from '../tests/factories.js';
import type { SunnyConfig } from '../src/config/index.js';
import type { EvalCase, ToolCallRecord, Trajectory } from './types.js';

const RUNTIME_KEY = Symbol.for('sunny.runtime');
const g = globalThis as Record<symbol, unknown>;

/** The production model under test by default (design D14 — "practice like we play"). */
export const DEFAULT_MODEL_ID = 'claude-sonnet-5';

/**
 * Run-level config knobs from env (grid cells): EVAL_THINKING / EVAL_EFFORT /
 * EVAL_DELIVERY / EVAL_TRANSLATOR_*. An unset (empty) var means "config default"
 * — omitted entirely, so the default cell stays byte-identical to production
 * behavior. (The PR #30 experiment knobs — promptVariant/envelope/fewshot/
 * composer — were retired when text became the default.)
 */
export function envRunConfig(env: NodeJS.ProcessEnv = process.env): Partial<SunnyConfig> {
  const rc: Partial<SunnyConfig> = {};
  if (env.EVAL_THINKING) rc.thinking = env.EVAL_THINKING as SunnyConfig['thinking'];
  if (env.EVAL_EFFORT) rc.effort = env.EVAL_EFFORT as SunnyConfig['effort'];
  // The utility (translator/backstop) model defaults to Haiku; override to measure a
  // stronger one.
  if (env.EVAL_UTILITY_MODEL) rc.utilityModelId = env.EVAL_UTILITY_MODEL;
  // The translator-history mini-axis and the translator cadence.
  if (env.EVAL_TRANSLATOR_HISTORY)
    rc.translatorHistory = env.EVAL_TRANSLATOR_HISTORY as SunnyConfig['translatorHistory'];
  if (env.EVAL_TRANSLATOR_N) rc.translatorEveryNSteps = Number(env.EVAL_TRANSLATOR_N);
  return rc;
}

/**
 * Behavioral eval harness (task 7.1 / agent-evals spec) — DURABLE path.
 *
 * Drives the REAL durable turn (`runConversation`) for a case in an in-process `@workflow/vitest`
 * Local World: it injects a test runtime (PGlite store + fake gateway + the case's config) on the
 * `getRuntime()` globalThis key the workflow's steps read, seeds the case's memory/conversation
 * through the real write APIs, `start()`s the workflow per input turn, awaits it, then reconstructs
 * the trajectory (tool calls, sends, `delivered`, started jobs) from the persisted D-MG9 turn for
 * the graders. The real model is selected by `modelId` (default the production model) — no model
 * mock is set, so `buildTurnModel` returns the real Anthropic provider.
 *
 * MUST run under the workflow Vitest config (`vitest.eval.config.ts`) so the `'use workflow'`
 * transform is active — `tsx` cannot run a durable workflow.
 */
export async function runEvalCase(
  c: EvalCase,
  modelId = DEFAULT_MODEL_ID,
  // Run-level knobs (thinking/effort/translator/…) win over case config:
  // case `setup.config` encodes case semantics (e.g. a tiny recentWindowSize); the
  // comparison grid must be able to force one configuration uniformly.
  runConfig: Partial<SunnyConfig> = {},
): Promise<Trajectory> {
  const tdb = await createTestDb();
  const config = makeConfig({ ...c.setup?.config, modelId, ...runConfig });
  await initMemory(config); // create the memory tree so instruction assembly reads clean files
  await seedMemory(config, c.setup?.memory ?? []);

  // Seed the captured memory core verbatim so the rebuilt system prompt matches production
  // (the core — esp. SUNNY.md conventions — shapes behavior; an empty core makes elicitation
  // rates unfaithful). Written straight to the runtime's core files (after initMemory's defaults).
  if (c.setup?.memoryCore) {
    const paths = memoryPaths(config.runtimeDir);
    mkdirSync(paths.root, { recursive: true });
    if (c.setup.memoryCore.user != null) writeFileSync(paths.USER, c.setup.memoryCore.user);
    if (c.setup.memoryCore.sunny != null) writeFileSync(paths.SUNNY, c.setup.memoryCore.sunny);
    if (c.setup.memoryCore.index != null) writeFileSync(paths.INDEX, c.setup.memoryCore.index);
  }

  const store = new ConversationStore(tdb.db, config.recentWindowSize);
  const gateway = new FakeGateway();
  // Inject the runtime the workflow's `'use step'` units read via `getRuntime()` (same seam the
  // production memo + the workflow test harness use). `stubJobs`: a start_job choice is graded,
  // but the job itself must not run (real model + a zombie run that blocks teardown).
  g[RUNTIME_KEY] = Promise.resolve({ config, gateway, store, db: tdb.db, stubJobs: true });

  try {
    // Seed prior conversation through the real store (so format drift is caught).
    let n = 0;
    for (const seed of c.setup?.conversation ?? []) {
      n += 1;
      if (seed.role === 'user') {
        await store.appendInbound(
          makeChannelEvent({
            threadId: OWNER_THREAD,
            messageId: `seed-${n}`,
            text: seed.text,
            senderName: seed.senderName ?? 'Devon',
            isOwner: c.setup?.isOwner ?? true,
            isGroup: c.setup?.isGroup ?? false,
          }),
        );
      } else if (seed.scratch != null || seed.sends) {
        // Rich assistant turn (scratch and/or multiple bubbles): persist a real
        // D-MG9 turn payload so history replays the exact production shape —
        // incl. the deliberately poisoned scratch-only turns of miss-chain cases.
        const sends = seed.sends ?? (seed.text ? [seed.text] : []);
        await store.appendTurn(
          OWNER_THREAD,
          makeAssistantTurnPayload({ scratch: seed.scratch, sends, id: `seed-${n}` }),
          sends.join('\n') || seed.text,
        );
      } else {
        await store.appendOutbound(OWNER_THREAD, `seed-${n}`, seed.text);
      }
    }

    // Seed REAL captured turns verbatim (fixture-from-a-trace): user turns through appendInbound,
    // assistant turns through appendTurn with their raw UIMessage payload, so the turn reconstructs
    // the EXACT production history (incl. the scratch/send_message ratio that drives elicitation).
    let f = 0;
    for (const turn of c.setup?.fixtureTurns ?? []) {
      f += 1;
      if (turn.role === 'user') {
        await store.appendInbound(
          makeChannelEvent({
            threadId: OWNER_THREAD,
            messageId: `fixture-${f}`,
            text: turn.text,
            isOwner: c.setup?.isOwner ?? true,
            isGroup: c.setup?.isGroup ?? false,
          }),
        );
      } else {
        await store.appendTurn(OWNER_THREAD, turn.payload ?? null, turn.text);
      }
    }

    const inputs = Array.isArray(c.input) ? c.input : [c.input];
    for (let i = 0; i < inputs.length; i++) {
      const ev = makeChannelEvent({
        threadId: OWNER_THREAD,
        messageId: `input-${i + 1}`,
        text: inputs[i]!,
        isOwner: c.setup?.isOwner ?? true,
        isGroup: c.setup?.isGroup ?? false,
      });
      await store.appendInbound(ev);
      // One durable turn per input — the SAME run the gateway router starts in production.
      const run = await start(runConversation, [{ threadId: OWNER_THREAD }]);
      await run.returnValue;
    }

    const trajectory = await buildTrajectory(store, gateway);
    // EVAL_DUMP_DIR: write a human-readable transcript per case run (hand sanity-checks).
    if (process.env.EVAL_DUMP_DIR) {
      await dumpTranscript(process.env.EVAL_DUMP_DIR, c.name, store, trajectory);
    }
    return trajectory;
  } finally {
    // TOMBSTONE, never delete: an abandoned (parked/hung) run's step can wake
    // minutes later and call getRuntime() — with the key ABSENT the production
    // memo boots the REAL runtime (Sendblue gateway + scheduler + the real
    // DATABASE_URL) inside the eval process (observed 2026-07-04; no sends went
    // out, but only because the process died before a scheduler tick). The
    // tombstone keeps zombies sandboxed: a fresh FakeGateway swallows any late
    // send; the torn-down store just fails their steps.
    g[RUNTIME_KEY] = Promise.resolve({
      config,
      gateway: new FakeGateway(),
      store,
      db: tdb.db,
      stubJobs: true,
    });
    // Best-effort: a leaked background run holding the PGlite connection can make
    // close() hang; an abandoned world is cheaper than a stuck scorecard. The
    // escape timer stays REF'D — unref'd it can be the last live handle and the
    // process exits cleanly mid-scorecard (see withWatchdog in run.eval.test.ts).
    await Promise.race([
      tdb.teardown().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
  }
}

/** Render the full stored window + graded-turn verdict to EVAL_DUMP_DIR (one md per run). */
async function dumpTranscript(
  dir: string,
  caseName: string,
  store: ConversationStore,
  t: Trajectory,
): Promise<void> {
  const window = await store.recentWindow(OWNER_THREAD);
  const lines: string[] = [`# ${caseName}`, ``, `delivered=${t.delivered} recovered=${t.recovered}`, ``];
  for (const row of window) {
    if (row.role === 'user') {
      lines.push(`USER (${row.senderName ?? row.senderId}): ${row.text}`);
      continue;
    }
    const payload = row.payload as {
      parts?: Array<Record<string, unknown>>;
      metadata?: { delivered?: string };
    } | null;
    if (!payload?.parts) {
      lines.push(`ASSISTANT (legacy text): ${row.text}`);
      continue;
    }
    lines.push(`ASSISTANT turn:`);
    // Text-mode rows label text by position: [interim] narration at/before the last tool
    // part, [reply] (the delivered final text) after it; relayed updates are [translator].
    const textRow =
      payload.metadata?.delivered === 'text' ||
      payload.parts.some((p) => p.type === 'data-translator');
    let lastTool = -1;
    payload.parts.forEach((p, i) => {
      if (String(p.type ?? '').startsWith('tool-')) lastTool = i;
    });
    payload.parts.forEach((p, i) => {
      const type = String(p.type ?? '');
      const indent = (label: string, text: string) =>
        lines.push(`  [${label}] ${text.replace(/\n/g, `\n   ${' '.repeat(label.length)}`)}`);
      if (type === 'text') {
        indent(textRow ? (i > lastTool ? 'reply' : 'interim') : 'scratch', String(p.text ?? ''));
      } else if (type === 'data-translator') {
        indent('translator', String((p.data as { text?: string })?.text ?? ''));
      } else if (type === 'tool-send_message') {
        lines.push(`  → send_message(${JSON.stringify((p.input as { text?: string })?.text ?? '')})`);
      } else if (type === 'tool-stay_silent') {
        lines.push(`  → stay_silent()`);
      } else if (type.startsWith('tool-')) {
        lines.push(`  → ${type.slice(5)}(${JSON.stringify(p.input ?? {}).slice(0, 200)})`);
      }
    });
  }
  mkdirSync(dir, { recursive: true });
  const slug = caseName.replace(/[^a-z0-9-]+/gi, '_');
  // One file per run: suffix with an increment to keep N>1 runs apart.
  let n = 1;
  const { existsSync } = await import('node:fs');
  while (existsSync(`${dir}/${slug}.${n}.md`)) n += 1;
  writeFileSync(`${dir}/${slug}.${n}.md`, lines.join('\n'));
}

/** Reconstruct the trajectory from the last persisted turn (D-MG9) + the fake gateway.
 *  Text-as-reply: the reply is the turn's FINAL text (sentinel-stripped), the "scratch"
 *  is the interim narration, and relayed translator updates are surfaced. */
async function buildTrajectory(
  store: ConversationStore,
  gateway: FakeGateway,
): Promise<Trajectory> {
  const window = await store.recentWindow(OWNER_THREAD);
  const lastTurn = [...window].reverse().find((m) => m.role === 'assistant');
  const payload = (lastTurn?.payload ?? { parts: [], metadata: {} }) as {
    parts: Array<{ type: string; input?: unknown; text?: string }>;
    metadata?: {
      delivered?: Trajectory['delivered'];
      recovered?: boolean;
      usage?: { in?: number | null; out?: number | null; cached?: number | null };
    };
  };
  const uiParts = payload.parts as unknown as UIMessage['parts'];

  const toolCalls: ToolCallRecord[] = payload.parts
    .filter((p) => p.type.startsWith('tool-'))
    .map((p) => ({ name: p.type.slice('tool-'.length), input: p.input }));

  const interimText = extractInterimText(uiParts);
  const scratch = interimText;
  const parsedFinal = stripNoReply(extractFinalText(uiParts));
  const finalText = parsedFinal.text;
  const translatorUpdates = extractTranslatorUpdates(uiParts).map((u) => u.text);

  const sends = gateway.texts();
  const delivered =
    payload.metadata?.delivered ??
    classifyTextDelivery(finalText, interimText, parsedFinal.sentinel);
  const u = payload.metadata?.usage;

  return {
    toolCalls,
    sends,
    delivered,
    recovered: payload.metadata?.recovered === true,
    // The model's `start_job` choices, from the persisted turn parts (the durable `startJobStep`
    // launches the real job; graders only need that the model *chose* it).
    startJobs: toolCalls.filter((tc) => tc.name === 'start_job'),
    finalText,
    scratch,
    translatorUpdates,
    interimText,
    usage: {
      inputTokens: u?.in ?? 0,
      outputTokens: u?.out ?? 0,
      cachedInputTokens: u?.cached ?? 0,
    },
  };
}
