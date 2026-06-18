import { apiGet } from '../api';
import type { ActivityTurn, Health as HealthData, TurnUsage } from '../types';
import { ErrorNote, Loading, PageTitle, StatusDot, formatTime, useAsync } from '../components/ui';

// Activity & health (5.5): per-turn token/cache/delivery/step metrics from stored
// turn metadata, and a service/db/scheduler/gateway health panel. Base UI Tabs
// split the two views.

function fmt(n: number | null): string {
  return n == null ? '—' : n.toLocaleString();
}

function usageCells(u: TurnUsage | null) {
  return (
    <>
      <td className="pr-md text-right tabular-nums">{fmt(u?.in ?? null)}</td>
      <td className="pr-md text-right tabular-nums">{fmt(u?.out ?? null)}</td>
      <td className="pr-md text-right tabular-nums text-success">{fmt(u?.cached ?? null)}</td>
      <td className="pr-md text-right tabular-nums text-warning">{fmt(u?.cacheWrite ?? null)}</td>
    </>
  );
}

function ActivityTab() {
  const state = useAsync<{ turns: ActivityTurn[] }>(
    () => apiGet<{ turns: ActivityTurn[] }>('/activity'),
    [],
  );
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <ErrorNote error={state.error} />;
  if (state.data.turns.length === 0)
    return <p className="text-fg-dim">No recorded turns yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="text-fg-dim">
          <tr>
            <th className="pr-md text-left font-normal">When</th>
            <th className="pr-md text-left font-normal">Delivery</th>
            <th className="pr-md text-right font-normal">Steps</th>
            <th className="pr-md text-right font-normal">In</th>
            <th className="pr-md text-right font-normal">Out</th>
            <th className="pr-md text-right font-normal">Cached</th>
            <th className="pr-md text-right font-normal">C-Write</th>
          </tr>
        </thead>
        <tbody>
          {state.data.turns.map((t) => (
            <tr key={t.id}>
              <td className="pr-md text-fg-muted">{formatTime(t.timestamp)}</td>
              <td className="pr-md">
                <span className={t.delivery === 'fallback_text' ? 'text-warning' : 'text-fg-muted'}>
                  {t.delivery ?? '—'}
                </span>
              </td>
              <td className="pr-md text-right tabular-nums">{fmt(t.steps)}</td>
              {usageCells(t.usage)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HealthRow({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-sm">
        <StatusDot ok={ok} />
        <span className="text-fg">{name}</span>
      </div>
      <span className="text-fg-dim">{detail}</span>
    </div>
  );
}

function HealthTab() {
  const state = useAsync<HealthData>(() => apiGet<HealthData>('/health'), []);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <ErrorNote error={state.error} />;
  const h = state.data;
  return (
    <div>
      <HealthRow name="Service" ok={h.service.ok} detail={h.service.detail} />
      <HealthRow name="Database" ok={h.database.ok} detail={h.database.detail} />
      <HealthRow name="Scheduler" ok={h.scheduler.ok} detail={h.scheduler.detail} />
      <HealthRow name="Gateway" ok={h.gateway.ok} detail={h.gateway.detail} />
      <HealthRow
        name="Unprocessed Inbound"
        ok={h.unprocessedInbound === 0}
        detail={String(h.unprocessedInbound)}
      />
      <p className="mt-md text-fg-dim">Checked {formatTime(h.generatedAt)}</p>
    </div>
  );
}

export function Activity() {
  return (
    <div>
      <PageTitle>Activity</PageTitle>
      <ActivityTab />
    </div>
  );
}

export function Health() {
  return (
    <div>
      <PageTitle>Health</PageTitle>
      <HealthTab />
    </div>
  );
}
