/**
 * Run `fn` after any prior task for the same `key` has settled, recording the new tail on
 * `chain` — a per-key serialization primitive (durable-main-loop). The gateway uses it to
 * deliver a thread's outbound messages strictly in order (two `send_message`s in one turn run
 * as separate, potentially concurrent durable steps; serializing the REST sends keeps bubbles
 * from arriving out of order). Different keys never block each other. A prior task's
 * rejection does NOT block the next (`fn` runs regardless), and the stored chain copy swallows
 * errors so the chain never wedges.
 */
export function runSerial<T>(
  chain: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chain.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chain.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
