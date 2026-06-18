import { apiGet } from '../api';
import type { TopicDoc, TopicSummary } from '../types';
import { Markdown } from '../components/Markdown';
import { Link } from '../components/Link';
import { ErrorNote, Loading, PageTitle, useAsync } from '../components/ui';

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
      <p className="mb-md">
        <Link to="memory">← all topics</Link>
      </p>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' && <Markdown>{state.data.content || '_(empty)_'}</Markdown>}
    </div>
  );
}

function MemoryHome() {
  const idx = useAsync<MemoryIndex>(() => apiGet<MemoryIndex>('/memory/topics'), []);
  return (
    <div>
      <PageTitle>Memory</PageTitle>
      {idx.status === 'loading' && <Loading />}
      {idx.status === 'error' && <ErrorNote error={idx.error} />}
      {idx.status === 'ready' &&
        (idx.data.topics.length === 0 ? (
          <p className="text-fg-dim">No topic docs yet.</p>
        ) : (
          <ul>
            {idx.data.topics.map((t) => (
              <li key={t.name} className="flex items-baseline gap-md">
                <Link to={`memory/${encodeURIComponent(t.name)}`}>{t.name}</Link>
                {t.summary && <span className="text-fg-dim">{t.summary}</span>}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function Memory({ topic }: { topic: string | null }) {
  return topic ? <TopicView name={topic} /> : <MemoryHome />;
}
