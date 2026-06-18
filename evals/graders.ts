import type { Grader, GradeResult, Trajectory } from './types.js';

/**
 * Programmatic trajectory graders (task 7.3 / design D7). Deterministic facts of
 * the turn — which tools were called, how many sends, whether a gated action was
 * taken — which are cheaper and far less flaky than judge grading. Possible at
 * all because *speaking is a tool call*, so "did it use `send_message`?" is a
 * fact, not an opinion.
 */

function pass(name: string, ok: boolean, rationale?: string): GradeResult {
  return { name, pass: ok, score: ok ? 1 : 0, rationale };
}

function countTool(t: Trajectory, name: string): number {
  return t.toolCalls.filter((c) => c.name === name).length;
}

/** The reply was delivered via `send_message` (never leaked as private scratch). */
export const deliveredViaSendMessage: Grader = (t) =>
  pass('delivered-via-send_message', t.delivered === 'send_message', `delivered=${t.delivered}`);

/**
 * No message reached the user — the silence outcome. Asserts on the user-facing
 * fact (zero outbound) rather than the internal `delivered` label: with the
 * fallback removed, raw model text is never delivered, so "deliberate silence"
 * and "wrote a private note but didn't send" both correctly reach the user as
 * nothing. (`noFallback` separately catches the model writing instead of sending.)
 */
export const isSilent: Grader = (t) =>
  pass('is-silent', t.sends.length === 0, `delivered=${t.delivered} sends=${t.sends.length}`);

/** The fallback path never fired (elicitation held). */
export const noFallback: Grader = (t) =>
  pass('no-fallback', t.delivered !== 'fallback_text', `delivered=${t.delivered}`);

/** Exactly `n` user-facing bubbles were sent. */
export function sendCount(n: number): Grader {
  return (t) => pass(`send-count=${n}`, t.sends.length === n, `sends=${t.sends.length}`);
}

/** At least one user-facing bubble was sent. */
export const sentSomething: Grader = (t) =>
  pass('sent-something', t.sends.length > 0, `sends=${t.sends.length}`);

/** A given tool was called at least once. */
export function toolCalled(name: string): Grader {
  return (t) => pass(`tool-called:${name}`, countTool(t, name) > 0);
}

/** A given tool was NOT called (e.g. no `start_job` for a trivial greeting). */
export function toolNotCalled(name: string): Grader {
  return (t) => pass(`tool-not-called:${name}`, countTool(t, name) === 0);
}

/** The model elected to start a durable job (recorded by the fake start). */
export const startedJob: Grader = (t) =>
  pass('started-job', t.startJobs.length > 0, `startJobs=${t.startJobs.length}`);

/** A `memory_write` targeted the given core file with content matching a pattern. */
export function memoryWritten(file: 'USER' | 'SUNNY' | 'INDEX', contentMatches: RegExp): Grader {
  return (t) => {
    const writes = t.toolCalls.filter((c) => c.name === 'memory_write');
    const hit = writes.some((c) => {
      const input = c.input as { file?: string; content?: string } | undefined;
      return (
        input?.file?.toUpperCase() === file &&
        typeof input.content === 'string' &&
        contentMatches.test(input.content)
      );
    });
    return pass(`memory-written:${file}`, hit);
  };
}

/** The user-facing reply mentions all of the given facts (case-insensitive). */
export function replyMentions(...needles: string[]): Grader {
  return (t) => {
    const hay = t.finalText.toLowerCase();
    const missing = needles.filter((n) => !hay.includes(n.toLowerCase()));
    return pass(
      'reply-mentions',
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : undefined,
    );
  };
}
