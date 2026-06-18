import { Tabs } from '@base-ui/react/tabs';
import { apiGet } from '../api';
import type { ActivityTurn, Health, TurnUsage } from '../types';
import {
  ErrorNote,
  Loading,
  Panel,
  PageTitle,
  StatusDot,
  formatTime,
  useAsync,
} from '../components/ui';

// Activity & health (5.5): per-turn token/cache/delivery/step metrics from stored
// turn metadata, and a service/db/scheduler/gateway health panel. Base UI Tabs
// split the two views.

function fmt(n: number | null): string {
  return n == null ? '—' : n.toLocaleString();
}

function usageCells(u: TurnUsage | null) {
  return (
    <>
      <td className="px-sm py-xs text-right tabular-nums">{fmt(u?.in ?? null)}</td>
      <td className="px-sm py-xs text-right tabular-nums">{fmt(u?.out ?? null)}</td>
      <td className="px-sm py-xs text-right tabular-nums text-success">{fmt(u?.cached ?? null)}</td>
      <td className="px-sm py-xs text-right tabular-nums text-warning">
        {fmt(u?.cacheWrite ?? null)}
      </td>
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
    return <p className="text-body-sm text-fg-dim">no recorded turns yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-body-sm">
        <thead className="text-label-sm tracking-[0.06em] text-fg-dim">
          <tr className="border-b border-border">
            <th className="px-sm py-xs text-left">when</th>
            <th className="px-sm py-xs text-left">delivery</th>
            <th className="px-sm py-xs text-right">steps</th>
            <th className="px-sm py-xs text-right">in</th>
            <th className="px-sm py-xs text-right">out</th>
            <th className="px-sm py-xs text-right">cached</th>
            <th className="px-sm py-xs text-right">cWrite</th>
          </tr>
        </thead>
        <tbody>
          {state.data.turns.map((t) => (
            <tr key={t.id} className="border-b border-border/40">
              <td className="px-sm py-xs text-fg-muted">{formatTime(t.timestamp)}</td>
              <td className="px-sm py-xs">
                <span className={t.delivery === 'fallback_text' ? 'text-warning' : 'text-fg-muted'}>
                  {t.delivery ?? '—'}
                </span>
              </td>
              <td className="px-sm py-xs text-right tabular-nums">{fmt(t.steps)}</td>
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
    <div className="flex items-center justify-between border-b border-border/40 py-sm">
      <div className="flex items-center gap-sm">
        <StatusDot ok={ok} />
        <span className="text-body-md text-fg">{name}</span>
      </div>
      <span className="text-body-sm text-fg-dim">{detail}</span>
    </div>
  );
}

function HealthTab() {
  const state = useAsync<Health>(() => apiGet<Health>('/health'), []);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <ErrorNote error={state.error} />;
  const h = state.data;
  return (
    <div>
      <HealthRow name="service" ok={h.service.ok} detail={h.service.detail} />
      <HealthRow name="database" ok={h.database.ok} detail={h.database.detail} />
      <HealthRow name="scheduler" ok={h.scheduler.ok} detail={h.scheduler.detail} />
      <HealthRow name="gateway" ok={h.gateway.ok} detail={h.gateway.detail} />
      <div className="mt-md flex items-baseline justify-between text-body-sm">
        <span className="text-fg-dim">unprocessed inbound</span>
        <span className={h.unprocessedInbound > 0 ? 'text-warning' : 'text-fg-muted'}>
          {h.unprocessedInbound}
        </span>
      </div>
      <p className="mt-md text-label-sm text-fg-dim">checked {formatTime(h.generatedAt)}</p>
    </div>
  );
}

export function Activity() {
  return (
    <div>
      <PageTitle>activity &amp; health</PageTitle>
      <Tabs.Root defaultValue="activity">
        <Tabs.List className="mb-md flex gap-xs border-b border-border">
          {(['activity', 'health'] as const).map((v) => (
            <Tabs.Tab
              key={v}
              value={v}
              className="px-md py-sm text-label-md tracking-[0.06em] text-fg-dim data-[selected]:border-b-2 data-[selected]:border-primary data-[selected]:text-primary"
            >
              {v}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="activity">
          <Panel title="recent turns">
            <ActivityTab />
          </Panel>
        </Tabs.Panel>
        <Tabs.Panel value="health">
          <Panel title="service health">
            <HealthTab />
          </Panel>
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
