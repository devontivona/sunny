#!/usr/bin/env node
/**
 * Drive a full Sunny turn over the programmatic loopback channel (durable-main-loop test infra)
 * — inject a message, then poll for Sunny's reply — WITHOUT Sendblue/iMessage. Exercises the
 * real pipeline (router → durable turn-run → delivery). Requires the server to run with
 * `SUNNY_TEST_CHANNEL=1` (and `SUNNY_DURABLE_TURNS=1` to test the durable path).
 *
 * Usage:
 *   SUNNY_TEST_SECRET=… node scripts/test-channel.mjs "hey sunny, what's up?"
 *   # deterministic (no model cost) — turn replies with EXACTLY this text:
 *   SUNNY_TEST_SECRET=… node scripts/test-channel.mjs "ping" --say "pong"
 *   # options: --thread <id>  --timeout <seconds>  --mock '<json mockSequenceModel array>'
 *
 * Env: SUNNY_BASE_URL (default http://localhost:8789), SUNNY_TEST_SECRET (required).
 *
 * Threads: `mockSequenceModel` (the deterministic seam) picks its response by counting assistant
 * messages in the prompt, so it only behaves on a FRESH thread (0 history → response[0]). So a
 * deterministic run (`--say`/`--mock`) defaults to a UNIQUE thread (isolated per run); a real-model
 * run reuses the stable default thread for continuity. Pass `--thread` to override either.
 */
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
// The message is the first positional arg (must come before any --flags).
const text = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
const base = (process.env.SUNNY_BASE_URL || 'http://localhost:8789').replace(/\/$/, '');
const secret = process.env.SUNNY_TEST_SECRET;
const timeoutS = Number(opt('timeout', '120'));
const say = opt('say', undefined);
const mockRaw = opt('mock', undefined);
// Deterministic runs need a fresh thread (see header); real-model runs fall back to the server's
// default thread (body.threadId omitted → LOOPBACK_DEFAULT_THREAD).
const deterministic = Boolean(say || mockRaw);
const thread =
  opt('thread', undefined) ??
  (deterministic
    ? `loopback:test:s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
    : undefined);

if (!text || text.startsWith('--')) {
  console.error(
    'usage: node scripts/test-channel.mjs "<message>" [--say "<reply>"] [--thread <id>] [--timeout <s>]',
  );
  process.exit(2);
}
if (!secret) {
  console.error("SUNNY_TEST_SECRET is required (must match the server's SUNNY_TEST_SECRET).");
  process.exit(2);
}

// Deterministic model: --say builds a send-once mock; --mock takes a raw descriptor array.
let modelResponses;
if (mockRaw) modelResponses = JSON.parse(mockRaw);
else if (say) {
  modelResponses = [
    { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: say }) },
    { type: 'text', text: '' },
  ];
}

const headers = { 'content-type': 'application/json', 'x-test-secret': secret };

async function main() {
  const inj = await fetch(`${base}/test/inbound`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, threadId: thread, modelResponses }),
  });
  if (!inj.ok) {
    console.error(`inject failed: ${inj.status} ${await inj.text()}`);
    process.exit(1);
  }
  const { threadId, cursor } = await inj.json();
  console.error(
    `→ injected on ${threadId} (cursor ${cursor}${modelResponses ? ', deterministic' : ', real model'}); waiting for reply…`,
  );

  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const out = await fetch(
      `${base}/test/outbound?threadId=${encodeURIComponent(threadId)}&afterSeq=${cursor}`,
      { headers },
    );
    if (!out.ok) {
      console.error(`poll failed: ${out.status} ${await out.text()}`);
      process.exit(1);
    }
    const { sends } = await out.json();
    if (sends && sends.length > 0) {
      for (const s of sends) console.log(s.text);
      return;
    }
  }
  console.error(`timed out after ${timeoutS}s with no reply.`);
  process.exit(1);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
