import { useState } from 'react';
import { Accordion } from '@base-ui/react/accordion';
import { apiGet } from '../api';
import type { ScheduleView } from '../types';
import { LinkButton } from '../components/Link';
import { ErrorNote, Loading, PageTitle, StatusDot, formatTime, useAsync } from '../components/ui';

// Schedules & runs (5.4): each schedule with kind/spec/label/next-run/active,
// and its recent run history (fired, status, output/error) in a Base UI Accordion.

function statusColor(status: string): string {
  if (status === 'completed') return 'text-success';
  if (status === 'failed') return 'text-error';
  return 'text-warning';
}

function ScheduleCard({ s }: { s: ScheduleView }) {
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <div className="mb-md">
      <div className="flex items-baseline justify-between gap-md">
        <div className="flex items-baseline gap-sm">
          <StatusDot ok={s.active} />
          <span className="font-bold text-fg">{s.label ?? '(Unlabeled)'}</span>
          <span className="text-fg-dim">[{s.kind}]</span>
          {s.fileClass && (
            <span
              className="text-fg-dim"
              title={
                s.fileClass === 'builtin'
                  ? 'Defined in agent/builtin/schedules/ — changed only by a code deploy'
                  : "Standing schedule — a portable file in the state repo (state/schedules/)"
              }
            >
              [{s.fileClass}]
            </span>
          )}
        </div>
        <span className="text-fg-dim">{s.active ? 'Active' : 'Inactive'}</span>
      </div>
      <dl className="mt-xs grid grid-cols-[7rem_1fr] text-fg-muted">
        <dt className="text-fg-dim">Spec</dt>
        <dd>{s.spec}</dd>
        <dt className="text-fg-dim">Next Run</dt>
        <dd>{formatTime(s.nextRunAt)}</dd>
        <dt className="text-fg-dim">Last Run</dt>
        <dd>{formatTime(s.lastRunAt)}</dd>
        <dt className="text-fg-dim">Prompt</dt>
        <dd>
          <span className={showPrompt ? '' : 'line-clamp-2'}>{s.prompt}</span>
          <LinkButton onClick={() => setShowPrompt((v) => !v)} className="text-fg-dim hover:text-primary">
            {showPrompt ? '› collapse' : '› expand'}
          </LinkButton>
        </dd>
      </dl>

      {s.runs.length > 0 && (
        <Accordion.Root className="mt-sm">
          <Accordion.Item value="runs">
            <Accordion.Header>
              <Accordion.Trigger className="group flex items-center gap-sm text-primary hover:underline">
                <span aria-hidden className="transition-transform group-data-[panel-open]:rotate-90">
                  ▸
                </span>
                Recent Runs ({s.runs.length})
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Panel className="pt-xs">
              <ul className="pl-md">
                {s.runs.map((r) => (
                  <li key={r.id}>
                    <div className="flex items-baseline justify-between gap-md">
                      <span className={statusColor(r.status)}>{r.status}</span>
                      <span className="text-fg-dim">{formatTime(r.firedAt)}</span>
                    </div>
                    {r.output && <div className="text-fg-muted">{r.output}</div>}
                    {r.error && <div className="text-error">{r.error}</div>}
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
      <PageTitle>Schedules &amp; Runs</PageTitle>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' &&
        (state.data.schedules.length === 0 ? (
          <p className="text-fg-dim">No schedules.</p>
        ) : (
          state.data.schedules.map((s) => <ScheduleCard key={s.id} s={s} />)
        ))}
    </div>
  );
}
