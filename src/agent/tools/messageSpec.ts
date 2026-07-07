import { z } from 'zod';

/**
 * `message` tool definition (run-audiences D-RA15: one addressed messaging verb over the delivery
 * bus). Sends to a NAMED OTHER entity — a roster person ("Kate") OR one of your own running
 * subagents (the id from delegate_task). Relaying to a person and steering a child are the same
 * bus operation to a different mailbox, so they are one tool; `send_message` (no recipient) stays
 * the reply-to-the-current-conversation primitive. Unifies the former `message_person` +
 * `message_subagent`. Node-free (zod only) so the workflow binds it; the side-effecting `execute`
 * lives in a `'use step'`.
 *
 * Roster people only — never arbitrary numbers (that act-as-owner capability is deferred to
 * security-permissions). A subagent recipient must be one of YOUR currently-running children.
 */
export const MESSAGE_SPEC = {
  description:
    'Send a message to a NAMED OTHER entity — either another person in your roster (the owner ' +
    'or a family member, e.g. "text Kate that I say hi") OR one of your own running subagents ' +
    '(pass the id from delegate_task, to steer it with new info). Use this ONLY to reach someone ' +
    'OTHER than whoever you are currently talking to; to reply in the current conversation, use ' +
    'send_message. For a person you can only reach the roster — NOT arbitrary numbers — and the ' +
    'message lands in your own chat with them, so make clear who it is from (e.g. "Devon says ' +
    'hi!"); after it sends, confirm back to the current user with send_message. For a person you ' +
    'may optionally attach ONE image by passing its local file path or a public URL in "image" ' +
    '(ignored when steering a subagent). Do not micromanage a subagent.',
  inputSchema: z.object({
    recipient: z
      .string()
      .min(1)
      .describe(
        'Who to message: a roster name (e.g. "Kate") or phone/email, OR a subagent id from ' +
          'delegate_task.',
      ),
    text: z
      .string()
      .min(1)
      .describe('The message to send. For a person, make clear who it is from.'),
    image: z
      .string()
      .optional()
      .describe('Optional: a local file path or URL of a single image (person recipients only).'),
  }),
} as const;
