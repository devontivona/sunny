import { apiGet } from '../api';
import type { MemoryCore, TopicDoc, TopicSummary } from '../types';
import { Markdown } from '../components/Markdown';
import { Link } from '../components/Link';
import { ErrorNote, Loading, Panel, PageTitle, useAsync } from '../components/ui';

interface MemoryIndex {
  index: string;
  topics: TopicSummary[];
}

// Memory browser (5.2): INDEX.md (the topic router) plus the list of topic docs,
// each openable. A topic is opened via the hash route `memory/<name>`.

function TopicView({ name }: { name: string }) {
  const state = useAsync<TopicDoc>(
    () => apiGet<TopicDoc>(`/memory/topics/${encodeURIComponent(name)}`),
    [name],
  );
  return (
    <div>
      <PageTitle>topics/{name}.md</PageTitle>
      <p className="mb-md text-label-md">
        <Link to="memory">← all topics</Link>
      </p>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' && (
        <div className="rounded-md border border-border bg-surface p-lg">
          <Markdown>{state.data.content || '_(empty)_'}</Markdown>
        </div>
      )}
    </div>
  );
}

function MemoryHome() {
  const core = useAsync<MemoryCore>(() => apiGet<MemoryCore>('/memory/core'), []);
  const idx = useAsync<MemoryIndex>(() => apiGet<MemoryIndex>('/memory/topics'), []);
  return (
    <div>
      <PageTitle>memory</PageTitle>
      <Panel title="INDEX.md">
        {core.status === 'loading' && <Loading />}
        {core.status === 'error' && <ErrorNote error={core.error} />}
        {core.status === 'ready' && <Markdown>{core.data.index || '_(empty)_'}</Markdown>}
      </Panel>
      <Panel title="topic documents">
        {idx.status === 'loading' && <Loading />}
        {idx.status === 'error' && <ErrorNote error={idx.error} />}
        {idx.status === 'ready' &&
          (idx.data.topics.length === 0 ? (
            <p className="text-body-sm text-fg-dim">no topic docs yet.</p>
          ) : (
            <ul className="space-y-xs">
              {idx.data.topics.map((t) => (
                <li key={t.name} className="flex items-baseline gap-md">
                  <Link to={`memory/${encodeURIComponent(t.name)}`} className="text-primary hover:underline">
                    {t.name}
                  </Link>
                  {t.summary && <span className="text-body-sm text-fg-dim">{t.summary}</span>}
                </li>
              ))}
            </ul>
          ))}
      </Panel>
    </div>
  );
}

export function Memory({ topic }: { topic: string | null }) {
  return topic ? <TopicView name={topic} /> : <MemoryHome />;
}
