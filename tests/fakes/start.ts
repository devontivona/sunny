import type { JobInput } from '../../workflows/job.js';
import type { StartJob } from '../../src/agent/tools/startJob.js';

/** One recorded `start_job` invocation. */
export interface RecordedStart {
  input: JobInput;
  runId: string;
}

/**
 * Recording fake durable-`start` (design D13 / task 2.4).
 *
 * Stands in for WDK's `start(runJob, …)` so the real loop can be driven in tests
 * and evals without a Workflow DevKit world: it records each `start_job` call and
 * returns a synthetic run id, launching nothing. In evals this lets a
 * tool-selection case grade that the model *chose* `start_job` (it appears in the
 * trajectory) without executing a durable run.
 */
export class FakeDurableStart {
  readonly calls: RecordedStart[] = [];

  /** The injectable starter — pass to `createAgentRunner({ start: fake.start })`. */
  readonly start: StartJob = (input) => {
    const runId = `fake-run-${this.calls.length + 1}`;
    this.calls.push({ input, runId });
    return Promise.resolve({ runId });
  };

  /** Number of durable jobs the turn tried to start. */
  get count(): number {
    return this.calls.length;
  }
}
