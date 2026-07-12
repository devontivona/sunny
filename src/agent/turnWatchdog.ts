/**
 * Turn-run watchdog (hung-model-stream exposure, 2026-07-03; activity-aware since
 * watchdog-activity, 2026-07-12): a stalled Anthropic stream can hang a durable
 * conversational turn FOREVER — there is no client-side timeout, and the SSE
 * keep-alive pings defeat undici's bodyTimeout. A custom-fetch timeout on the provider
 * does not survive WDK provider serialization (`serializeModelOptions` keeps only
 * JSON-serializable config, so a `fetch` closure is silently dropped when the model is
 * reconstructed inside a step bundle) — so the guard lives HERE, at the router level,
 * racing the run's `returnValue`.
 *
 * TWO thresholds, not one wall clock (the 2026-07-12 incident: a healthy 25-step email
 * sweep was executed at exactly the flat budget while a bash step was mid-flight):
 *  - INACTIVITY: no run-stream activity (model deltas, tool results) for `inactivityMs`
 *    → a true hang, caught as fast as the old flat budget.
 *  - HARD CAP: total runtime past `maxMs` → a runaway turn, even if still moving.
 *
 * Ported lessons from the eval-side `withWatchdog` precedent stay in force:
 *  - Timers are deliberately REF'D: when a durable run parks, this may be the only
 *    live handle left — unref'd, the process could drain and exit before it fires.
 *  - On fire, the abandoned promise is DEFUSED (`.catch(() => {})`): the zombie run's
 *    steps can fail much later (e.g. after a restart or teardown), and that late
 *    rejection would otherwise surface as an unhandled rejection.
 */

/** How often the activity-aware watchdog re-checks. Coarse on purpose: production
 *  thresholds are minutes, so ~15s adds negligible latency — but it adapts down for
 *  tiny budgets (tests use millisecond thresholds). */
const MAX_CHECK_INTERVAL_MS = 15_000;
function checkIntervalFor(inactivityMs: number, maxMs: number): number {
  return Math.max(5, Math.min(MAX_CHECK_INTERVAL_MS, Math.floor(Math.min(inactivityMs, maxMs) / 4)));
}

/** A turn-run exceeded a watchdog budget. The router catches this specifically and takes
 *  the abandon path (cancel + retire inbound + tell the user) instead of the generic
 *  run-failed logging. `reason` says WHICH budget fired: 'inactivity' (a true hang —
 *  nothing observable happened for the whole inactivity window) or 'cap' (still active,
 *  but past the absolute ceiling). */
export class TurnWatchdogTimeout extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly reason: 'inactivity' | 'cap' = 'cap',
  ) {
    super(`turn-run exceeded the watchdog ${reason} budget (${timeoutMs}ms)`);
    this.name = 'TurnWatchdogTimeout';
  }
}

export interface TurnWatchdogOpts {
  /** Abandon after this long with NO observable activity (a true hang). */
  inactivityMs: number;
  /** Abandon past this total runtime regardless of activity (the hard cap). */
  maxMs: number;
  /** Epoch ms of the run's most recent observable activity (stream chunk read).
   *  The watchdog clamps it to the race start, so a stale pre-run value is harmless. */
  lastActivityAt: () => number;
}

/**
 * Race `p` against the watchdog: resolve/reject with `p` if it settles in time,
 * otherwise reject with {@link TurnWatchdogTimeout} and defuse `p`'s eventual
 * settlement. The legacy single-number form (`raceTurnWatchdog(p, ms)`) is a flat
 * wall-clock race (no activity signal) and remains for eval-side callers.
 */
export function raceTurnWatchdog<T>(p: Promise<T>, opts: number | TurnWatchdogOpts): Promise<T> {
  if (typeof opts === 'number') return raceFlat(p, opts);
  const { inactivityMs, maxMs, lastActivityAt } = opts;
  const startedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    const timer = setInterval(() => {
      const now = Date.now();
      // Clamp to the race start: activity from before this run must not count for it.
      const lastActivity = Math.max(startedAt, lastActivityAt());
      let fired: TurnWatchdogTimeout | null = null;
      if (now - startedAt > maxMs) {
        fired = new TurnWatchdogTimeout(maxMs, 'cap');
      } else if (now - lastActivity > inactivityMs) {
        fired = new TurnWatchdogTimeout(inactivityMs, 'inactivity');
      }
      if (fired) {
        clearInterval(timer);
        p.catch(() => {}); // defuse the abandoned run's later rejection
        reject(fired);
      }
    }, checkIntervalFor(inactivityMs, maxMs)); // ref'd on purpose — see module doc
    p.then(
      (v) => {
        clearInterval(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearInterval(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** The original flat race (kept for the legacy overload). */
function raceFlat<T>(p: Promise<T>, ms: number): Promise<T> {
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
