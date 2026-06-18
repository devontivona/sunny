import { useState } from 'react';
import { apiGet } from '../api';
import type { ConversationMessage, SearchHit, ThreadSummary } from '../types';
import { Markdown } from '../components/Markdown';
import { Link, LinkButton } from '../components/Link';
import { ErrorNote, Loading, PageTitle, formatTime, useAsync } from '../components/ui';
import { navigate } from '../router';

// Conversation view (5.3): an index page (search + thread list) and a nested
// thread page (breadcrumb + messages with retained scratch + keyword search).

interface ThreadList {
  threads: ThreadSummary[];
}
interface ThreadDetail {
  threadId: string;
  label: string;
  messages: ConversationMessage[];
}

function Bubble({ m }: { m: ConversationMessage }) {
  const isSunny = m.role === 'assistant';
  return (
    <div className="mb-md">
      <div className="mb-xs flex items-baseline gap-sm text-fg-dim">
        <span className={isSunny ? 'text-secondary' : 'text-primary'}>
          {isSunny ? 'サニー' : m.senderName || 'You'}
        </span>
        <span>{formatTime(m.timestamp)}</span>
        {m.delivery && m.delivery !== 'send_message' && (
          <span className="text-warning">[{m.delivery}]</span>
        )}
      </div>
      {m.delivered.length > 0 ? (
        <div className="text-fg">
          {m.delivered.map((text, i) => (
            <Markdown key={i}>{text}</Markdown>
          ))}
        </div>
      ) : (
        !m.scratch && <div className="text-fg-dim italic">(silent turn)</div>
      )}
      {m.scratch && (
        <details className="mt-xs pl-md">
          <summary className="cursor-pointer list-none text-primary hover:underline [&::-webkit-details-marker]:hidden">
            › Retained scratch (private)
          </summary>
          <div className="mt-xs text-fg-muted">
            <Markdown>{m.scratch}</Markdown>
          </div>
        </details>
      )}
    </div>
  );
}

/** Index page: a search prompt above the thread list. When searching, the
 *  results replace the thread list as the body (annotations #5/#6). */
function ConversationIndex() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const searching = submitted.trim().length > 0;

  const threads = useAsync<ThreadList>(() => apiGet<ThreadList>('/conversation/threads'), []);
  const results = useAsync<{ results: SearchHit[] }>(
    () =>
      searching
        ? apiGet<{ results: SearchHit[] }>(`/conversation/search?q=${encodeURIComponent(submitted)}`)
        : Promise.resolve({ results: [] }),
    [submitted],
  );

  return (
    <div>
      <PageTitle>Conversation</PageTitle>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q);
        }}
        className="mb-md flex items-baseline gap-sm"
      >
        <span className="text-fg-dim" aria-hidden>
          $
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search message history…"
          className="flex-1 bg-transparent px-0 text-fg caret-primary outline-none placeholder:text-fg-dim"
        />
        {searching && (
          <LinkButton
            onClick={() => {
              setQ('');
              setSubmitted('');
            }}
          >
            clear
          </LinkButton>
        )}
      </form>

      {searching ? (
        results.status === 'loading' ? (
          <Loading />
        ) : results.status === 'error' ? (
          <ErrorNote error={results.error} />
        ) : results.data.results.length === 0 ? (
          <p className="text-fg-dim">No matches.</p>
        ) : (
          <ul className="space-y-sm">
            {results.data.results.map((h) => (
              <li key={h.id}>
                <div className="text-fg-dim">
                  <span className={h.role === 'assistant' ? 'text-secondary' : 'text-primary'}>
                    {h.role === 'assistant' ? 'サニー' : h.senderName || 'You'}
                  </span>{' '}
                  · {formatTime(h.timestamp)}
                </div>
                <div className="line-clamp-3 text-fg-muted">{h.text}</div>
              </li>
            ))}
          </ul>
        )
      ) : threads.status === 'loading' ? (
        <Loading />
      ) : threads.status === 'error' ? (
        <ErrorNote error={threads.error} />
      ) : threads.data.threads.length === 0 ? (
        <p className="text-fg-dim">No threads yet.</p>
      ) : (
        <ul>
          {threads.data.threads.map((t) => (
            <li key={t.threadId} className="flex items-baseline justify-between gap-md">
              <span className="min-w-0 truncate">
                <LinkButton onClick={() => navigate(`conversation/${encodeURIComponent(t.threadId)}`)}>
                  {t.label}
                </LinkButton>
              </span>
              <span className="shrink-0 whitespace-nowrap text-fg-dim">
                {t.count} · {formatTime(t.lastAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Nested thread page: breadcrumb back to the index, then the messages (#5). */
function ThreadPage({ threadId }: { threadId: string }) {
  const state = useAsync<ThreadDetail>(
    () => apiGet<ThreadDetail>(`/conversation/thread?id=${encodeURIComponent(threadId)}`),
    [threadId],
  );
  const label = state.status === 'ready' ? state.data.label : '…';
  return (
    <div>
      <div className="mb-md font-bold text-fg">
        <Link to="conversation">Conversation</Link>
        <span className="font-normal text-fg-dim"> / {label}</span>
      </div>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' &&
        (state.data.messages.length === 0 ? (
          <p className="text-fg-dim">No messages.</p>
        ) : (
          state.data.messages.map((m) => <Bubble key={m.id} m={m} />)
        ))}
    </div>
  );
}

export function Conversation({ threadId }: { threadId: string | null }) {
  return threadId ? <ThreadPage threadId={threadId} /> : <ConversationIndex />;
}
