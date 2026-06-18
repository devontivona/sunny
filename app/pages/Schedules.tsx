import { Accordion } from '@base-ui/react/accordion';
import { apiGet } from '../api';
import type { ScheduleView } from '../types';
import { ErrorNote, Loading, PageTitle, StatusDot, formatTime, useAsync } from '../components/ui';

// Schedules & runs (5.4): each schedule with kind/spec/label/next-run/active,
// and its recent run history (fired, status, output/error) in a Base UI Accordion.

function statusColor(status: string): string {
  if (status === 'completed') return 'text-success';
  if (status === 'failed') return 'text-error';
  return 'text-warning';
}

function ScheduleCard({ s }: { s: ScheduleView }) {
  return (
    <div className="mb-md rounded-md border border-border bg-surface p-md">
      <div className="flex items-baseline justify-between gap-md">
        <div className="flex items-baseline gap-sm">
          <StatusDot ok={s.active} />
          <span className="text-body-lg text-fg">{s.label ?? '(unlabeled)'}</span>
          <span className="rounded-sm bg-surface-elevated px-xs text-label-sm text-tertiary">
            {s.kind}
          </span>
        </div>
        <span className="text-label-sm text-fg-dim">{s.active ? 'active' : 'inactive'}</span>
      </div>
      <dl className="mt-sm grid grid-cols-[auto_1fr] gap-x-md gap-y-xs text-body-sm">
        <dt className="text-fg-dim">spec</dt>
        <dd className="text-fg-muted">{s.spec}</dd>
        <dt className="text-fg-dim">next run</dt>
        <dd className="text-fg-muted">{formatTime(s.nextRunAt)}</dd>
        <dt className="text-fg-dim">last run</dt>
        <dd className="text-fg-muted">{formatTime(s.lastRunAt)}</dd>
        <dt className="text-fg-dim">prompt</dt>
        <dd className="text-fg-muted line-clamp-2">{s.prompt}</dd>
      </dl>

      {s.runs.length > 0 && (
        <Accordion.Root className="mt-sm border-t border-border pt-sm">
          <Accordion.Item value="runs">
            <Accordion.Header>
              <Accordion.Trigger className="flex w-full items-center justify-between text-label-md tracking-[0.06em] text-fg-dim hover:text-fg">
                <span>recent runs ({s.runs.length})</span>
                <span aria-hidden>▾</span>
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Panel className="pt-sm">
              <ul className="space-y-xs">
                {s.runs.map((r) => (
                  <li key={r.id} className="rounded-sm bg-bg-dark/40 px-sm py-xs text-body-sm">
                    <div className="flex items-baseline justify-between">
                      <span className={statusColor(r.status)}>{r.status}</span>
                      <span className="text-label-sm text-fg-dim">{formatTime(r.firedAt)}</span>
                    </div>
                    {r.output && <div className="mt-xs text-fg-muted">{r.output}</div>}
                    {r.error && <div className="mt-xs text-error">{r.error}</div>}
                  </li>
                ))}
              </ul>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion.Root>
      )}
    </div>
  );
}

export function Schedules() {
  const state = useAsync<{ schedules: ScheduleView[] }>(
    () => apiGet<{ schedules: ScheduleView[] }>('/schedules'),
    [],
  );
  return (
    <div>
      <PageTitle>schedules &amp; runs</PageTitle>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' &&
        (state.data.schedules.length === 0 ? (
          <p className="text-body-sm text-fg-dim">no schedules.</p>
        ) : (
          state.data.schedules.map((s) => <ScheduleCard key={s.id} s={s} />)
        ))}
    </div>
  );
}
