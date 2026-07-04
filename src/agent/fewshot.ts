import type { UIMessage } from 'ai';
import { envelopePrefix } from './delivery.js';
import type { PromptVariant } from './prompt.js';

/**
 * Canned few-shot exchanges (elicitation experiment, `config.fewshot`): a short
 * block of (user → assistant) turns prepended to EVERY conversation window,
 * demonstrating the delivery mechanics in-band — replies via `send_message`,
 * work continuing after a send, brief third-person scratch (or none), and
 * `stay_silent` on an ack. An example is worth paragraphs of instruction, and
 * unlike the system prompt it shows the exact wire shape the model must produce.
 *
 * Design constraints:
 * - Content is deliberately toy/generic (pasta timing, one allergy note) so no
 *   canned "fact" can be mistaken for something the real user said; the system
 *   prompt additionally marks the opening exchanges as demonstrations
 *   (`fewshotSystemNote`).
 * - Static per (owner, variant, envelope) — a stable byte prefix, so it extends
 *   the prompt-cache prefix instead of breaking it (the caller puts a cache
 *   breakpoint on the block's last message).
 * - Tool-call ids are fixed `fewshot-*` strings. They are PROMPT INPUT ONLY:
 *   the persisted row is rebuilt from the live turn's own steps (see
 *   `finalizeTurn`), so these ids can never enter the store or collide with a
 *   real turn's `tool_use` ids.
 * - No reasoning parts — history is always replayed reasoning-stripped
 *   (`stripReasoning`), so this matches the shape of every real prior turn.
 */

type Part = UIMessage['parts'][number];

function toolPart(
  name: string,
  toolCallId: string,
  input: unknown,
  output: unknown = 'delivered',
): Part {
  return {
    type: `tool-${name}`,
    toolCallId,
    state: 'output-available',
    input,
    output,
  } as Part;
}

export function fewshotUIMessages(
  ownerName: string,
  variant: PromptVariant,
  envelope: boolean,
): Omit<UIMessage, 'id'>[] {
  const wrap = (text: string) => (envelope ? envelopePrefix(ownerName, false, false) + text : text);
  const user = (text: string): Omit<UIMessage, 'id'> => ({
    role: 'user',
    parts: [{ type: 'text', text: wrap(text) }],
  });

  // The one scratch note in the block, in the register the active variant asks for.
  // All three are third-person working notes; the wording matches each variant's copy.
  const note =
    variant === 'gateway'
      ? 'sent timing guidance; did not mention salting the water'
      : variant === 'diary'
        ? 'answered the timing question — left out the salt-the-water tangent'
        : 'sent timing guidance; trimmed the salt-the-water tangent';

  return [
    // 1. A plain question: the reply is a send_message CALL; a brief third-person
    //    note may follow the send (never a composed reply).
    user('quick one — pasta, 10 or 12 min?'),
    {
      role: 'assistant',
      parts: [
        toolPart('send_message', 'fewshot-1-send', {
          text: 'Depends on the cut — 10 for spaghetti, 12 for rigatoni. Which are you making?',
        }),
        { type: 'text', text: note } as Part,
      ],
    },
    // 2. Work + speech in one turn: a tool call, then the send. Sending doesn't end
    //    the turn and the reply still never appears as plain text.
    user("also remember i'm allergic to shellfish"),
    {
      role: 'assistant',
      parts: [
        toolPart(
          'memory_write',
          'fewshot-2-mem',
          { file: 'USER', action: 'add', content: '- Allergic to shellfish' },
          'Recorded.',
        ),
        toolPart('send_message', 'fewshot-2-send', {
          text: 'Noted — shellfish allergy saved for good.',
        }),
      ],
    },
    // 3. An ack: deliberate silence is a stay_silent CALL, not an unsent text reply.
    user('thanks!'),
    {
      role: 'assistant',
      parts: [toolPart('stay_silent', 'fewshot-3-silent', {}, 'ok: staying silent')],
    },
  ];
}
