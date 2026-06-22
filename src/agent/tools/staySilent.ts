import { tool } from 'ai';
import { z } from 'zod';

/** Mutable flag so the runner can detect a deliberate choice of silence (D-MG8). */
export interface SilenceFlag {
  silent: boolean;
}

/**
 * The `stay_silent` tool (messaging-gateway D-MG8).
 *
 * Makes silence an AFFIRMATIVE act rather than the absence of a `send_message`
 * call. Every turn should end by calling exactly one of `send_message` (to speak)
 * or `stay_silent` (to say nothing) — so "neither was called, yet the model wrote
 * text" is an unambiguous elicitation miss the runner can recover from, while a
 * genuine choice of silence is explicit and never triggers recovery.
 */
export function createStaySilentTool(flag: SilenceFlag) {
  return tool({
    description:
      'Deliberately say nothing this turn. Call this when the latest message just closes the ' +
      'loop — a 👍 or reaction, "ok", "thanks", "got it", "sounds good" — and there is ' +
      'genuinely nothing useful to add. Calling stay_silent IS how you choose silence: it ends ' +
      'the turn with no message delivered. Do not call it if there is something worth saying — ' +
      'use send_message for that.',
    inputSchema: z.object({}),
    execute: async () => {
      flag.silent = true;
      return 'ok: staying silent';
    },
  });
}
