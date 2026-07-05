/**
 * Turn-run watchdog (hung-model-stream exposure, 2026-07-03): a stalled Anthropic stream can
 * hang a durable conversational turn FOREVER — there is no client-side timeout, and the SSE
 * keep-alive pings defeat undici's bodyTimeout. A custom-fetch timeout on the provider does
 * not survive WDK provider serialization (`serializeModelOptions` keeps only JSON-serializable
 * config, so a `fetch` closure is silently dropped when the model is reconstructed inside a
 * step bundle) — so the wall-clock guard lives HERE, at the router level, racing the run's
 * `returnValue`. Ported from the eval-side `withWatchdog` precedent (evals/run.eval.test.ts),
 * including its two hard-won lessons:
 *
 *  - The timer is deliberately REF'D: when a durable run parks, this timer may be the only
 *    live handle left — unref'd, the process could drain and exit before the watchdog fires.
 *  - On fire, the abandoned promise is DEFUSED (`.catch(() => {})`): the zombie run's steps
 *    can fail much later (e.g. after a restart or teardown), and that late rejection would
 *    otherwise surface as an unhandled rejection.
 */

/** A turn-run exceeded the watchdog budget. The router catches this specifically and takes
 *  the abandon path (cancel + retire inbound + tell the user) instead of the generic
 *  run-failed logging. */
export class TurnWatchdogTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`turn-run exceeded the watchdog budget (${timeoutMs}ms)`);
    this.name = 'TurnWatchdogTimeout';
  }
}

/**
 * Race `p` against a ref'd timer: resolve/reject with `p` if it settles within `ms`,
 * otherwise reject with {@link TurnWatchdogTimeout} and defuse `p`'s eventual settlement
 * (a hung run abandoned here may still reject long after — that tail must never become
 * an unhandled rejection).
 */
export function raceTurnWatchdog<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      p.catch(() => {}); // defuse the abandoned run's later rejection
      reject(new TurnWatchdogTimeout(ms));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
