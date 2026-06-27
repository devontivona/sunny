import { tool } from 'ai';
import { STAY_SILENT_SPEC } from './sendMessageSpec.js';

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
    ...STAY_SILENT_SPEC,
    execute: async () => {
      flag.silent = true;
      return 'ok: staying silent';
    },
  });
}
