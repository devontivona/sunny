import { z } from 'zod';

/**
 * `message_person` tool definition (multiplayer-family: cross-thread relayed sends). Lets Sunny
 * send an iMessage to ANOTHER person — someone other than whoever it's currently talking to — on
 * the requesting user's behalf ("text Kate that I say hi"). Roster-only: it can reach the owner and
 * family, never arbitrary numbers (arbitrary recipients are an act-as-owner capability deferred to
 * security-permissions). Node-free (zod only) so it can be bound at the workflow level; the
 * side-effecting `execute` lives in a `'use step'` in the workflow.
 */
export const MESSAGE_PERSON_SPEC = {
  description:
    "Send an iMessage to ANOTHER person on the user's behalf — e.g. the user says " +
    '"text Kate that I say hi". Use this ONLY to message someone OTHER than whoever you are ' +
    'currently talking to; to reply in the current conversation, use send_message instead. You can ' +
    'only reach people in the roster (the owner and family members) — NOT arbitrary numbers. The ' +
    'message lands in your own chat with that person, so always make clear who it is from ' +
    '(e.g. "Devon says hi!"). You may optionally attach ONE image by passing its local file path ' +
    '(a file you produced) or a public URL in "image" — pass the path or URL, never the raw bytes. ' +
    'After it sends, confirm back to the current user with send_message.',
  inputSchema: z.object({
    person: z
      .string()
      .min(1)
      .describe('Who to message — a roster name (e.g. "Kate") or their phone/email.'),
    text: z
      .string()
      .min(1)
      .describe('The exact message to send them. Make clear who it is from.'),
    image: z
      .string()
      .optional()
      .describe('Optional: a local file path or URL of a single image to attach.'),
  }),
} as const;
