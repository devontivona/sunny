/**
 * Thread-id derivation (task 3.3). Sendblue encodes the thread kind in the id:
 * groups as `sendblue:<from>:g:<groupId>` and DMs as `sendblue:<from>:<contact>`.
 * The third colon-segment is the discriminator. Extracted into one pure helper so
 * the gateway driver and the conversation store derive group-ness identically
 * (previously duplicated in `sendblue.ts` and `store.ts`).
 */
export function isGroupThreadId(threadId: string): boolean {
  return threadId.split(':')[2] === 'g';
}

/**
 * Construct a Sendblue DM thread id for a contact (multiplayer-family: relayed sends). Mirrors the
 * adapter's encoding — `sendblue:<base64url(from)>:<base64url(contact)>` — so a proactive send to a
 * never-before-contacted roster member addresses the same thread the adapter would. Both arguments
 * are the channel-stable E.164/email strings. Only call this from a real Node step (uses Buffer).
 */
export function sendblueDmThreadId(fromNumber: string, contact: string): string {
  const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
  return `sendblue:${enc(fromNumber)}:${enc(contact)}`;
}
