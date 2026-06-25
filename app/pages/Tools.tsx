import { apiGet } from '../api';
import type { ToolEntry, ToolsView } from '../types';
import { ErrorNote, Loading, PageTitle, useAsync } from '../components/ui';

// Tools directory (web-dashboard agent-tooling delta): the registered tools, each
// with its name, one-line purpose, owner-only flag, and input parameters (derived
// from the live tool schema). Observe-only — no control to invoke or configure a
// tool. The credential registry is its own page (Credentials).

function ToolCard({ t }: { t: ToolEntry }) {
  return (
    <li className="mb-md">
      <div className="flex items-baseline gap-sm">
        <span className="font-bold text-fg">{t.name}</span>
        {t.ownerOnly && (
          <span className="text-fg-dim" title="Only available on owner DMs">
            [owner-only]
          </span>
        )}
      </div>
      <div className="text-fg-muted">{t.purpose}</div>
      {t.params.length > 0 && (
        <dl className="mt-xs grid grid-cols-[auto_1fr] gap-x-md text-fg-muted">
          {t.params.map((p) => (
            <div key={p.name} className="contents">
              <dt className="whitespace-nowrap text-fg-dim">
                {p.name}
                <span className="text-fg-dim">: {p.type}</span>
                {p.required && <span className="text-warning"> *</span>}
              </dt>
              <dd>{p.description ?? ''}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function Tools() {
  const state = useAsync<ToolsView>(() => apiGet<ToolsView>('/tools'), []);
  return (
    <div>
      <PageTitle>Tools</PageTitle>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' &&
        (state.data.tools.length === 0 ? (
          <p className="text-fg-dim">No tools.</p>
        ) : (
          <ul>
            {state.data.tools.map((t) => (
              <ToolCard key={t.name} t={t} />
            ))}
          </ul>
        ))}
    </div>
  );
}
