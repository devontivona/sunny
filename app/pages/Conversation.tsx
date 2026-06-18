import { useState } from 'react';
import { apiGet } from '../api';
import type { ConversationMessage, SearchHit, ThreadSummary } from '../types';
import { Markdown } from '../components/Markdown';
import { ErrorNote, Loading, Panel, PageTitle, formatTime, useAsync } from '../components/ui';
import { navigate } from '../router';

// Conversation view (5.3): recent messages per thread — role, time, delivered
// bubbles, and (for Sunny) the retained private scratch — plus keyword search
// over the full archive (backed by `recall()` / FTS).

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
      <div className="mb-xs flex items-baseline gap-sm text-label-sm tracking-[0.08em] text-fg-dim">
        <span className={isSunny ? 'text-secondary' : 'text-primary'}>
          {isSunny ? 'サニー' : (m.senderName ?? 'user')}
        </span>
        <span>{formatTime(m.timestamp)}</span>
        {m.delivery && m.delivery !== 'send_message' && (
          <span className="text-warning">[{m.delivery}]</span>
        )}
      </div>
      {m.delivered.length > 0 ? (
        <div className="space-y-xs">
          {m.delivered.map((text, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-surface px-md py-sm text-body-md text-fg"
            >
              <Markdown>{text}</Markdown>
            </div>
          ))}
        </div>
      ) : (
        !m.scratch && <div className="text-body-sm text-fg-dim italic">(silent turn)</div>
      )}
      {m.scratch && (
        <details className="mt-xs rounded-md border border-dashed border-border/70 bg-bg-dark/40 px-md py-sm">
          <summary className="cursor-pointer text-label-sm tracking-[0.08em] text-fg-dim">
            retained scratch (private)
          </summary>
          <div className="mt-sm text-body-sm text-fg-muted">
            <Markdown>{m.scratch}</Markdown>
          </div>
        </details>
      )}
    </div>
  );
}

function Search() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const state = useAsync<{ results: SearchHit[] }>(
    () =>
      submitted.trim()
        ? apiGet<{ results: SearchHit[] }>(`/conversation/search?q=${encodeURIComponent(submitted)}`)
        : Promise.resolve({ results: [] }),
    [submitted],
  );
  return (
    <Panel title="keyword search">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q);
        }}
        className="mb-sm flex gap-sm"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search message history…"
          className="flex-1 rounded-sm border border-border bg-bg-dark px-sm py-xs text-body-sm text-fg outline-none focus:border-primary"
        />
        <button
          type="submit"
          className="rounded-sm border border-border px-md py-xs text-label-md text-fg-muted hover:bg-surface-elevated hover:text-fg"
        >
          recall
        </button>
      </form>
      {submitted && state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {submitted && state.status === 'ready' && (
        state.data.results.length === 0 ? (
          <p className="text-body-sm text-fg-dim">no matches.</p>
        ) : (
          <ul className="space-y-sm">
            {state.data.results.map((h) => (
              <li key={h.id} className="border-l-2 border-border pl-md">
                <div className="text-label-sm text-fg-dim">
                  <span className={h.role === 'assistant' ? 'text-secondary' : 'text-primary'}>
                    {h.role === 'assistant' ? 'サニー' : (h.senderName ?? 'user')}
                  </span>{' '}
                  · {formatTime(h.timestamp)}
                </div>
                <div className="text-body-sm text-fg-muted line-clamp-3">{h.text}</div>
              </li>
            ))}
          </ul>
        )
      )}
    </Panel>
  );
}

function ThreadDetailView({ threadId }: { threadId: string }) {
  const state = useAsync<ThreadDetail>(
    () => apiGet<ThreadDetail>(`/conversation/thread?id=${encodeURIComponent(threadId)}`),
    [threadId],
  );
  return (
    <div>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' && (
        <Panel title={state.data.label}>
          {state.data.messages.length === 0 ? (
            <p className="text-body-sm text-fg-dim">no messages.</p>
          ) : (
            state.data.messages.map((m) => <Bubble key={m.id} m={m} />)
          )}
        </Panel>
      )}
    </div>
  );
}

export function Conversation({ threadId }: { threadId: string | null }) {
  const threads = useAsync<ThreadList>(() => apiGet<ThreadList>('/conversation/threads'), []);
  return (
    <div>
      <PageTitle>conversation</PageTitle>
      <Search />
      <Panel title="threads">
        {threads.status === 'loading' && <Loading />}
        {threads.status === 'error' && <ErrorNote error={threads.error} />}
        {threads.status === 'ready' &&
          (threads.data.threads.length === 0 ? (
            <p className="text-body-sm text-fg-dim">no threads yet.</p>
          ) : (
            <ul className="space-y-xs">
              {threads.data.threads.map((t) => (
                <li key={t.threadId}>
                  <button
                    type="button"
                    onClick={() => navigate(`conversation/${encodeURIComponent(t.threadId)}`)}
                    className={[
                      'flex w-full items-baseline justify-between gap-md rounded-sm px-sm py-xs text-left hover:bg-surface-elevated',
                      threadId === t.threadId ? 'bg-surface-elevated' : '',
                    ].join(' ')}
                  >
                    <span className="text-body-sm text-primary">{t.label}</span>
                    <span className="shrink-0 text-label-sm text-fg-dim">
                      {t.count} · {formatTime(t.lastAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Panel>
      {threadId && <ThreadDetailView threadId={threadId} />}
    </div>
  );
}
