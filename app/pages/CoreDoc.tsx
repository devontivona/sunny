import { apiGet } from '../api';
import type { MemoryCore } from '../types';
import { Markdown } from '../components/Markdown';
import { ErrorNote, Loading, PageTitle, useAsync } from '../components/ui';

// SUNNY.md / USER.md views (5.1): the always-on core, rendered as sanitized
// markdown. Both read the same core endpoint and pick a field.

export function CoreDoc({ which }: { which: 'sunny' | 'user' }) {
  const state = useAsync<MemoryCore>(() => apiGet<MemoryCore>('/memory/core'), []);
  const title = which === 'sunny' ? 'SUNNY.md' : 'USER.md';

  return (
    <div>
      <PageTitle>{title}</PageTitle>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' && <Markdown>{state.data[which] || '_(empty)_'}</Markdown>}
    </div>
  );
}
