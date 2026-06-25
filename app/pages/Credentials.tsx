import { apiGet } from '../api';
import type { CredentialsView } from '../types';
import { ErrorNote, Loading, PageTitle, useAsync } from '../components/ui';

// Credential registry (web-dashboard agent-tooling delta): each registered
// credential by name → its `op://` reference + purpose. References are pointers,
// NEVER values (D-CR2/D-CR5) — no secret is shown. Observe-only.

export function Credentials() {
  const state = useAsync<CredentialsView>(() => apiGet<CredentialsView>('/credentials'), []);
  return (
    <div>
      <PageTitle>Credentials</PageTitle>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' &&
        (state.data.credentials.length === 0 ? (
          <p className="text-fg-dim">No credentials registered.</p>
        ) : (
          <ul>
            {state.data.credentials.map((c) => (
              <li key={c.name} className="mb-sm">
                <div className="flex items-baseline gap-sm">
                  <span className="font-bold text-fg">{c.name}</span>
                  <span className="text-fg-dim">{c.reference}</span>
                </div>
                {c.purpose && <div className="text-fg-muted">{c.purpose}</div>}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
