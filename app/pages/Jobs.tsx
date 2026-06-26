import { apiGet } from '../api';
import type { JobsView, JobRunView } from '../types';
import { ErrorNote, Loading, PageTitle, StatusDot, formatTime, useAsync } from '../components/ui';
import { Link, LinkButton } from '../components/Link';
import { useLiveRun } from '../components/live';
import { RunView } from '../components/RunView';
import { navigate } from '../router';

// Durable jobs (observability): background jobs (start_job → runJob) and scheduled
// runs, read from the Workflow DevKit world. Observe-only — status, timing, and step
// counts so a job that hangs or fails is visible. No control to start/stop a run.

function statusColor(status: string): string {
  if (status === 'completed') return 'text-success';
  if (status === 'failed') return 'text-error';
  if (status === 'running') return 'text-warning';
  return 'text-fg-dim';
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function JobRow({ j }: { j: JobRunView }) {
  const ok = j.status === 'completed';
  const running = j.status === 'running';
  return (
    <div className="mb-md">
      <div className="flex items-baseline justify-between gap-md">
        <div className="flex items-baseline gap-sm">
          <StatusDot ok={ok} />
          {running ? (
            <LinkButton onClick={() => navigate(`jobs/${encodeURIComponent(j.id)}`)}>
              {j.kind}
            </LinkButton>
          ) : (
            <span className="font-bold text-fg">{j.kind}</span>
          )}
        </div>
        <span className={statusColor(j.status)}>{j.status}</span>
      </div>
      <dl className="mt-xs grid grid-cols-[7rem_1fr] text-fg-muted">
        <dt className="text-fg-dim">Started</dt>
        <dd>{formatTime(j.startedAt)}</dd>
        <dt className="text-fg-dim">Duration</dt>
        <dd>{formatDuration(j.durationMs)}</dd>
        <dt className="text-fg-dim">Steps</dt>
        <dd>
          {j.stepCount}
          {j.failedSteps > 0 && <span className="text-error"> · {j.failedSteps} failed</span>}
        </dd>
      </dl>
    </div>
  );
}

/** Live view of one actively-running job — the same trajectory UI as a turn
 *  (8.1), streamed from the durable WDK run stream by run id. Observe-only. */
function JobRunPage({ runId }: { runId: string }) {
  const { message, run } = useLiveRun(runId, 'job');
  return (
    <div>
      <div className="mb-md font-bold text-fg">
        <Link to="jobs">Jobs</Link>
        <span className="font-normal text-fg-dim"> / {run?.label ?? 'run'}</span>
      </div>
      <RunView message={message} run={run} />
    </div>
  );
}

function JobsList() {
  const state = useAsync<JobsView>(() => apiGet<JobsView>('/jobs'), []);
  return (
    <div>
      <PageTitle>Jobs</PageTitle>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' &&
        (state.data.jobs.length === 0 ? (
          <p className="text-fg-dim">No jobs yet.</p>
        ) : (
          state.data.jobs.map((j) => <JobRow key={j.id} j={j} />)
        ))}
    </div>
  );
}

export function Jobs({ runId }: { runId: string | null }) {
  return runId ? <JobRunPage runId={runId} /> : <JobsList />;
}
