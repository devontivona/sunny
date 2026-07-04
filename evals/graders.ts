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
 * The reply reached the user by the active mode's intended path — `send_message`
 * (tool mode) OR direct final text (text mode). The mode-agnostic delivery grader
 * every substantive case wires (text-delivery migration, Phase 5), so the same
 * dataset gates both cells of the EVAL_DELIVERY grid.
 */
export const deliveredReply: Grader = (t) =>
  pass(
    'delivered-reply',
    t.delivered === 'send_message' || t.delivered === 'text',
    `delivered=${t.delivered}`,
  );

/**
 * No message reached the user — the silence outcome. Asserts on the user-facing
 * fact (zero outbound) rather than the internal `delivered` label: with the
 * fallback removed, raw model text is never delivered, so "deliberate silence"
 * and "wrote a private note but didn't send" both correctly reach the user as
 * nothing. (`noFallback` separately catches the model writing instead of sending.)
 */
export const isSilent: Grader = (t) =>
  pass('is-silent', t.sends.length === 0, `delivered=${t.delivered} sends=${t.sends.length}`);

/**
 * The (final) turn deliberately chose silence — read from the `delivered`
 * classification, not from outbound count. Use this for MULTI-TURN cases: `sends`
 * accumulates across every turn of the case, so `isSilent`'s zero-outbound check
 * would wrongly fail whenever an earlier turn legitimately spoke. `delivered` is
 * the last turn's outcome, which is what these cases grade.
 */
export const finalTurnSilent: Grader = (t) =>
  pass('final-turn-silent', t.delivered === 'silence', `delivered=${t.delivered}`);

/** The fallback path never fired (elicitation held). */
export const noFallback: Grader = (t) =>
  pass('no-fallback', t.delivered !== 'fallback_text', `delivered=${t.delivered}`);

/** The backstop did NOT fire — the primary model elicited on its own (D-MG8). */
export const noRecovery: Grader = (t) =>
  pass('no-recovery', !t.recovered, `recovered=${t.recovered}`);

/**
 * Pre-recovery (primary) elicitation: the reply was delivered AND the backstop did
 * not have to rescue it. This is the metric that the old, masking backstop hid — a
 * green `delivered=send_message` could still be a primary miss that recovery saved.
 * Grading it makes "backstop fired" a tracked regression, not an invisible save.
 */
export const elicitedWithoutRecovery: Grader = (t) =>
  pass(
    'elicited-without-recovery',
    (t.delivered === 'send_message' || t.delivered === 'text') && !t.recovered,
    `delivered=${t.delivered} recovered=${t.recovered}`,
  );

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

/**
 * Deterministic cross-check for the scratch-quality judge (advisory): flags
 * scratch that directly addresses the user. A crude heuristic on purpose — it
 * counts second-person pronouns — so it's free, unmeterable-cost-proof, and
 * catches gross leaks; the judge grader covers the fuzzy middle. Vacuous pass
 * on empty scratch (no scratch is the ideal, not a gap).
 */
export const scratchNotSecondPerson: Grader = (t) => {
  if (!t.scratch) return { ...pass('scratch-not-second-person', true), advisory: true };
  const hits = t.scratch.match(/\byou(?:r|'re|'ve|'ll|'d)?\b/gi)?.length ?? 0;
  const words = t.scratch.split(/\s+/).length;
  // ≥2 second-person hits AND >2 per 100 words — a lone "what the user ('you') asked"
  // style mention shouldn't trip it, a composed reply will.
  const leaked = hits >= 2 && hits / words > 0.02;
  return {
    ...pass('scratch-not-second-person', !leaked, `hits=${hits} words=${words}`),
    advisory: true,
  };
};

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
