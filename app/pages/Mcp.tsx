import { apiGet } from '../api';
import type { McpServerView, McpServersView } from '../types';
import { ErrorNote, Loading, PageTitle, useAsync } from '../components/ui';

// MCP servers directory (mcp D-MCP8): the registered external MCP tool servers, each
// with its name, host (NOT the token-bearing URL), transport, auth reference by name
// (never a value), enabled state, and last-probed tool inventory. Data-driven from the
// registry — a server added via mcp_manage surfaces here automatically. Observe-only.

function ServerCard({ s }: { s: McpServerView }) {
  return (
    <li className="mb-md">
      <div className="flex items-baseline gap-sm">
        <span className="font-bold text-fg">{s.name}</span>
        <span className={s.enabled ? 'text-success' : 'text-fg-dim'}>
          [{s.enabled ? 'enabled' : 'disabled'}]
        </span>
        <span className="text-fg-dim">{s.host}</span>
      </div>
      <div className="text-fg-muted">
        {s.transport}
        {s.auth ? ` · ${s.auth}` : ' · no auth'}
        {s.probedAt ? ` · probed ${new Date(s.probedAt).toLocaleString()}` : ' · not probed'}
      </div>
      {s.purpose && <div className="text-fg-muted">{s.purpose}</div>}
      {s.tools.length > 0 && (
        <dl className="mt-xs grid grid-cols-[auto_1fr] gap-x-md text-fg-muted">
          {s.tools.map((t) => (
            <div key={t.name} className="contents">
              <dt className="whitespace-nowrap text-fg-dim">{t.name}</dt>
              <dd>{t.description}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function Mcp() {
  const state = useAsync<McpServersView>(() => apiGet<McpServersView>('/mcp'), []);
  return (
    <div>
      <PageTitle>MCP servers</PageTitle>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' &&
        (state.data.servers.length === 0 ? (
          <p className="text-fg-dim">No MCP servers registered.</p>
        ) : (
          <ul>
            {state.data.servers.map((s) => (
              <ServerCard key={s.name} s={s} />
            ))}
          </ul>
        ))}
    </div>
  );
}
