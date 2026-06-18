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
