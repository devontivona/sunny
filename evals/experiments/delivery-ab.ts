import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { SteerHandle } from '../../src/agent/dispatcher.js';
import { createTestDb } from '../../tests/db.js';
import { createTestRuntime } from '../../tests/harness.js';
import { makeChannelEvent, makeConfig, seedMemory, OWNER_THREAD } from '../../tests/factories.js';
import { SCENARIOS, type Scenario, type Tier } from './scenarios.js';

/**
 * Delivery-design A/B: `send_message` tool (current) vs text-as-message (candidate).
 *
 * Arm A = `tool` mode (the model speaks only via send_message; recovery pass backs
 * a miss). Arm B = `text` mode (the model's reply text IS the message; only
 * `stay_silent` exists; no recovery). Same prompt-core, same dataset.
 *
 * Head-to-head failure modes: A can **ghost** (write text, forget the tool — caught
 * by recovery, measured pre-recovery via `recovered`); B can **over-talk** (reply
 * on a turn where silence was right). We also score restraint on acks, elicitation
 * on substantive turns, reply quality, bubbles/reply, tokens, latency.
 * Run: `npm run experiment:delivery`.
 */
const NO_STEER: SteerHandle = { drain: () => [] };
const JUDGE = anthropic('claude-sonnet-4-6');
type Arm = 'tool' | 'text';

interface TurnRecord {
  arm: Arm;
  scenario: string;
  tier: Tier;
  turnIndex: number;
  userText: string;
  isAck: boolean;
  delivered: string;
  recovered: boolean;
  spoke: boolean;
  bubbles: number;
  inTok: number;
  outTok: number;
  cachedTok: number;
  latencyMs: number;
  replyScore?: number;
}

async function judgeReply(r: TurnRecord, sends: string[]): Promise<number> {
  const { object } = await generateObject({
    model: JUDGE,
    schema: z.object({ score: z.number().min(1).max(5) }),
    prompt: [
      'Rate this iMessage assistant reply 1-5 on helpfulness AND fit for iMessage (concise,',
      'warm, plain text, natural texting tone, not over-long). 5 = excellent, 1 = poor.',
      '',
      `User said: ${r.userText}`,
      `Assistant reply (bubbles): ${JSON.stringify(sends)}`,
    ].join('\n'),
  });
  return object.score;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function summarize(rs: TurnRecord[]) {
  const ack = rs.filter((r) => r.isAck);
  const sub = rs.filter((r) => !r.isAck);
  const spoke = rs.filter((r) => r.spoke);
  const scored = rs.filter((r) => r.replyScore != null);
  return {
    turns: rs.length,
    elicitationSubstantive: mean(sub.map((r) => (r.spoke ? 1 : 0))),
    ghostRatePreRecovery: mean(sub.map((r) => (r.recovered ? 1 : 0))),
    overTalkOnAcks: mean(ack.map((r) => (r.spoke ? 1 : 0))),
    restraintOnAcks: mean(ack.map((r) => (!r.spoke ? 1 : 0))),
    recoveryFired: mean(rs.map((r) => (r.recovered ? 1 : 0))),
    bubblesPerReply: Number(mean(spoke.map((r) => r.bubbles)).toFixed(2)),
    replyQuality: Number(mean(scored.map((r) => r.replyScore!)).toFixed(2)),
    outTokMean: Math.round(mean(rs.map((r) => r.outTok))),
    latencyMsMean: Math.round(mean(rs.map((r) => r.latencyMs))),
    ackTurns: ack.length,
    substantiveTurns: sub.length,
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — this experiment calls real models. Aborting.');
    process.exit(2);
  }
  const argN = process.argv.indexOf('--n');
  const N = argN >= 0 ? Number(process.argv[argN + 1]) : 3;

  const all: Array<{ rec: TurnRecord; sends: string[] }> = [];
  // We need the actual delivered text for the quality judge; re-capture sends inline.
  for (const arm of ['tool', 'text'] as Arm[]) {
    for (let run = 0; run < N; run++) {
      for (const scenario of SCENARIOS) {
        // playScenario doesn't return sends text; rerun capture via a thin wrapper.
        const recs = await playScenarioWithSends(arm, scenario);
        all.push(...recs);
        process.stderr.write(`[${arm} run${run + 1}] ${scenario.name}: ${recs.length} turns\n`);
      }
    }
  }

  process.stderr.write(`Judging ${all.filter((x) => x.rec.spoke).length} delivered replies…\n`);
  for (const x of all) {
    if (x.rec.spoke && x.sends.length > 0) x.rec.replyScore = await judgeReply(x.rec, x.sends);
  }

  const A = summarize(all.filter((x) => x.rec.arm === 'tool').map((x) => x.rec));
  const B = summarize(all.filter((x) => x.rec.arm === 'text').map((x) => x.rec));

  const dir = join(process.cwd(), 'evals', 'experiments', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `delivery-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify({ n: N, arms: { tool: A, text: B }, records: all.map((x) => x.rec) }, null, 2),
  );

  const row = (label: string, a: string, b: string) =>
    console.log(`  ${label.padEnd(30)} ${a.padStart(10)}  ${b.padStart(10)}`);
  console.log(
    `\nDelivery A/B  (N=${N}, ${SCENARIOS.length} scenarios, ${A.turns}+${B.turns} turns)\n`,
  );
  console.log(`  ${'metric'.padEnd(30)} ${'A: tool'.padStart(10)}  ${'B: text'.padStart(10)}`);
  row('elicitation (substantive)', pct(A.elicitationSubstantive), pct(B.elicitationSubstantive));
  row('GHOST rate (A pre-recovery)', pct(A.ghostRatePreRecovery), '—');
  row('OVER-TALK on acks (B risk)', pct(A.overTalkOnAcks), pct(B.overTalkOnAcks));
  row('restraint on acks', pct(A.restraintOnAcks), pct(B.restraintOnAcks));
  row('recovery fired', pct(A.recoveryFired), pct(B.recoveryFired));
  row('reply quality (1-5)', String(A.replyQuality), String(B.replyQuality));
  row('bubbles / reply', String(A.bubblesPerReply), String(B.bubblesPerReply));
  row('tokens out (mean)', String(A.outTokMean), String(B.outTokMean));
  row('latency ms (mean)', String(A.latencyMsMean), String(B.latencyMsMean));
  console.log(`\n  (acks=${A.ackTurns}, substantive=${A.substantiveTurns} per arm)`);
  console.log(`\nFull records → ${file}`);
}

/** Like playScenario but also returns each turn's delivered bubbles (for the judge). */
async function playScenarioWithSends(
  arm: Arm,
  scenario: Scenario,
): Promise<Array<{ rec: TurnRecord; sends: string[] }>> {
  const tdb = await createTestDb();
  try {
    const config = makeConfig();
    await seedMemory(config, scenario.setup?.memory ?? []);
    const rt = createTestRuntime({
      db: tdb.db,
      model: anthropic(config.modelId),
      recoveryModel: anthropic(config.recoveryModelId),
      config,
      deliveryMode: arm,
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
    const ackTurns = new Set(scenario.ackTurns ?? []);
    const seen = new Set<string>();
    const out: Array<{ rec: TurnRecord; sends: string[] }> = [];
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
      const meta =
        ((newAsst?.payload as { metadata?: Record<string, unknown> } | undefined)?.metadata as {
          delivered?: string;
          recovered?: boolean;
          usage?: { in?: number | null; out?: number | null; cached?: number | null };
        }) ?? {};
      const delivered = meta.delivered ?? 'silence';
      out.push({
        sends,
        rec: {
          arm,
          scenario: scenario.name,
          tier: scenario.tier,
          turnIndex: i,
          userText,
          isAck: ackTurns.has(i),
          delivered,
          recovered: !!meta.recovered,
          spoke: delivered === 'send_message',
          bubbles: sends.length,
          inTok: meta.usage?.in ?? 0,
          outTok: meta.usage?.out ?? 0,
          cachedTok: meta.usage?.cached ?? 0,
          latencyMs,
        },
      });
    }
    return out;
  } finally {
    await tdb.teardown();
  }
}

void main();
