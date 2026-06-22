import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { SteerHandle } from '../../src/agent/dispatcher.js';
import { extractScratch } from '../../src/agent/turn.js';
import { createTestDb } from '../../tests/db.js';
import { createTestRuntime } from '../../tests/harness.js';
import { makeChannelEvent, makeConfig, seedMemory, OWNER_THREAD } from '../../tests/factories.js';
import { SCENARIOS, type Scenario, type Tier } from './scenarios.js';

/**
 * Thinking on/off A/B experiment.
 *
 * Arm A = `adaptive` thinking (current production); Arm B = thinking `off` (the
 * model's plain-text scratchpad becomes its only reasoning channel). Same prompt,
 * same dataset — only the thinking config differs. We measure what the saturated
 * pass/fail graders can't: per-turn PRE-recovery elicitation (did the primary
 * model call send_message/stay_silent with no recovery nudge), scratch volume +
 * usefulness, token cost, and latency. Run on demand: `npm run experiment:thinking`.
 */
const NO_STEER: SteerHandle = { drain: () => [] };
const JUDGE = anthropic('claude-sonnet-4-6');

type Arm = 'adaptive' | 'off';

interface TurnRecord {
  arm: Arm;
  scenario: string;
  tier: Tier;
  turnIndex: number;
  userText: string;
  recovered: boolean;
  delivered: string;
  /** The primary model elicited a tool itself (no recovery nudge needed). */
  primaryElicited: boolean;
  scratch: string;
  scratchLen: number;
  sends: string[];
  inTok: number;
  outTok: number;
  cachedTok: number;
  latencyMs: number;
  scratchClass?: 'leaked_reply' | 'useful_context' | 'reasoning_noise';
  replyScore?: number;
}

async function playScenario(arm: Arm, scenario: Scenario): Promise<TurnRecord[]> {
  const tdb = await createTestDb();
  try {
    const config = makeConfig({ thinking: arm });
    await seedMemory(config, scenario.setup?.memory ?? []);
    const rt = createTestRuntime({
      db: tdb.db,
      model: anthropic(config.modelId),
      recoveryModel: anthropic(config.recoveryModelId),
      config,
    });

    let seedN = 0;
    for (const seed of scenario.setup?.conversation ?? []) {
      seedN += 1;
      if (seed.role === 'user') {
        await rt.store.appendInbound(
          makeChannelEvent({ threadId: OWNER_THREAD, messageId: `seed-${seedN}`, text: seed.text }),
        );
      } else {
        await rt.store.appendOutbound(OWNER_THREAD, `seed-${seedN}`, seed.text);
      }
    }

    const seen = new Set<string>();
    const records: TurnRecord[] = [];
    for (let i = 0; i < scenario.turns.length; i++) {
      const userText = scenario.turns[i]!;
      const ev = makeChannelEvent({ threadId: OWNER_THREAD, messageId: `t-${i}`, text: userText });
      await rt.store.appendInbound(ev);
      const sentBefore = rt.gateway.sent.length;
      const t0 = Date.now();
      await rt.runTurn(ev, NO_STEER);
      const latencyMs = Date.now() - t0;
      const sends = rt.gateway.sent.slice(sentBefore).map((s) => s.text);

      const win = await rt.store.recentWindow(OWNER_THREAD);
      const newAsst = [...win]
        .reverse()
        .find((m) => m.role === 'assistant' && !seen.has(m.messageId));
      if (newAsst) seen.add(newAsst.messageId);
      const payload = (newAsst?.payload ?? { parts: [], metadata: {} }) as {
        parts: Parameters<typeof extractScratch>[0];
        metadata?: {
          recovered?: boolean;
          delivered?: string;
          usage?: { in?: number | null; out?: number | null; cached?: number | null };
        };
      };
      const scratch = extractScratch(payload.parts);
      const meta = payload.metadata ?? {};
      records.push({
        arm,
        scenario: scenario.name,
        tier: scenario.tier,
        turnIndex: i,
        userText,
        recovered: !!meta.recovered,
        delivered: meta.delivered ?? 'silence',
        primaryElicited: !meta.recovered,
        scratch,
        scratchLen: scratch.length,
        sends,
        inTok: meta.usage?.in ?? 0,
        outTok: meta.usage?.out ?? 0,
        cachedTok: meta.usage?.cached ?? 0,
        latencyMs,
      });
    }
    return records;
  } finally {
    await tdb.teardown();
  }
}

async function judgeScratch(r: TurnRecord): Promise<TurnRecord['scratchClass']> {
  const { object } = await generateObject({
    model: JUDGE,
    schema: z.object({
      label: z.enum(['leaked_reply', 'useful_context', 'reasoning_noise']),
    }),
    prompt: [
      'An iMessage assistant ("Sunny") speaks only by calling a send_message tool; its plain',
      'text is a private scratchpad never shown to the user. Classify the scratchpad text:',
      '- "leaked_reply": it IS a reply meant for the user that should have been sent.',
      '- "useful_context": private notes that would genuinely help a later follow-up (intent,',
      '  options weighed, things deliberately not said).',
      '- "reasoning_noise": step-by-step reasoning/thinking with no lasting value.',
      '',
      `User said: ${r.userText}`,
      `Sunny delivered (via send_message): ${JSON.stringify(r.sends)}`,
      `Scratchpad text:\n${r.scratch}`,
    ].join('\n'),
  });
  return object.label;
}

async function judgeReply(r: TurnRecord): Promise<number> {
  const { object } = await generateObject({
    model: JUDGE,
    schema: z.object({ score: z.number().min(1).max(5) }),
    prompt: [
      'Rate this iMessage assistant reply 1-5 on helpfulness AND fit for iMessage (concise,',
      'warm, plain text, not over-long). 5 = excellent, 1 = poor.',
      '',
      `User said: ${r.userText}`,
      `Assistant reply (one or more bubbles): ${JSON.stringify(r.sends)}`,
    ].join('\n'),
  });
  return object.score;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function summarize(records: TurnRecord[]) {
  const byTier = (tier: Tier) => records.filter((r) => r.tier === tier);
  const elicit = (rs: TurnRecord[]) => mean(rs.map((r) => (r.primaryElicited ? 1 : 0)));
  const withScratch = records.filter((r) => r.scratchLen > 0);
  const classOf = (c: string) => withScratch.filter((r) => r.scratchClass === c).length;
  const scored = records.filter((r) => r.replyScore != null);
  return {
    turns: records.length,
    primaryElicitation: elicit(records),
    elicitationByTier: {
      multiturn: elicit(byTier('multiturn')),
      ambiguous: elicit(byTier('ambiguous')),
      complex: elicit(byTier('complex')),
    },
    recoveryRate: mean(records.map((r) => (r.recovered ? 1 : 0))),
    scratchFreq: mean(records.map((r) => (r.scratchLen > 0 ? 1 : 0))),
    scratchLenMean: Math.round(mean(records.map((r) => r.scratchLen))),
    scratchClass: {
      leaked_reply: classOf('leaked_reply'),
      useful_context: classOf('useful_context'),
      reasoning_noise: classOf('reasoning_noise'),
      total: withScratch.length,
    },
    tokens: {
      inMean: Math.round(mean(records.map((r) => r.inTok))),
      outMean: Math.round(mean(records.map((r) => r.outTok))),
      cachedMean: Math.round(mean(records.map((r) => r.cachedTok))),
    },
    latencyMsMean: Math.round(mean(records.map((r) => r.latencyMs))),
    replyQualityMean: Number(mean(scored.map((r) => r.replyScore!)).toFixed(2)),
    deliveredDist: {
      send_message: records.filter((r) => r.delivered === 'send_message').length,
      silence: records.filter((r) => r.delivered === 'silence').length,
      fallback_text: records.filter((r) => r.delivered === 'fallback_text').length,
    },
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — this experiment calls real models. Aborting.');
    process.exit(2);
  }
  const argN = process.argv.indexOf('--n');
  const N = argN >= 0 ? Number(process.argv[argN + 1]) : 3;
  const arms: Arm[] = ['adaptive', 'off'];

  const all: TurnRecord[] = [];
  for (const arm of arms) {
    for (let run = 0; run < N; run++) {
      for (const scenario of SCENARIOS) {
        const recs = await playScenario(arm, scenario);
        all.push(...recs);
        process.stderr.write(`[${arm} run${run + 1}] ${scenario.name}: ${recs.length} turns\n`);
      }
    }
  }

  // Judges (Sonnet): scratch usefulness (turns with scratch) + reply quality (turns that sent).
  process.stderr.write(`Judging ${all.length} turns…\n`);
  for (const r of all) {
    if (r.scratchLen > 0) r.scratchClass = await judgeScratch(r);
    if (r.sends.length > 0) r.replyScore = await judgeReply(r);
  }

  const A = summarize(all.filter((r) => r.arm === 'adaptive'));
  const B = summarize(all.filter((r) => r.arm === 'off'));
  const report = { n: N, scenarios: SCENARIOS.length, arms: { adaptive: A, off: B } };

  const dir = join(process.cwd(), 'evals', 'experiments', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `thinking-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ ...report, records: all }, null, 2));

  const row = (label: string, a: string, b: string) =>
    console.log(`  ${label.padEnd(26)} ${a.padStart(10)}  ${b.padStart(10)}`);
  console.log(
    `\nThinking A/B  (N=${N}, ${SCENARIOS.length} scenarios, ${A.turns}+${B.turns} turns)\n`,
  );
  console.log(
    `  ${'metric'.padEnd(26)} ${'A: think on'.padStart(10)}  ${'B: think off'.padStart(10)}`,
  );
  row('primary elicitation', pct(A.primaryElicitation), pct(B.primaryElicitation));
  row('  · multiturn', pct(A.elicitationByTier.multiturn), pct(B.elicitationByTier.multiturn));
  row('  · ambiguous', pct(A.elicitationByTier.ambiguous), pct(B.elicitationByTier.ambiguous));
  row('  · complex', pct(A.elicitationByTier.complex), pct(B.elicitationByTier.complex));
  row('recovery fired', pct(A.recoveryRate), pct(B.recoveryRate));
  row('scratch frequency', pct(A.scratchFreq), pct(B.scratchFreq));
  row('scratch len (chars)', String(A.scratchLenMean), String(B.scratchLenMean));
  row(
    'scratch useful/noise/leak',
    `${A.scratchClass.useful_context}/${A.scratchClass.reasoning_noise}/${A.scratchClass.leaked_reply}`,
    `${B.scratchClass.useful_context}/${B.scratchClass.reasoning_noise}/${B.scratchClass.leaked_reply}`,
  );
  row('tokens out (mean)', String(A.tokens.outMean), String(B.tokens.outMean));
  row('latency ms (mean)', String(A.latencyMsMean), String(B.latencyMsMean));
  row('reply quality (1-5)', String(A.replyQualityMean), String(B.replyQualityMean));
  console.log(`\nFull records → ${file}`);
}

void main();
