import { useEffect, useState } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { apiGet } from '../api';
import type { ConversationMessage, SearchHit, ThreadSummary } from '../types';
import { Markdown } from '../components/Markdown';
import { Link, LinkButton } from '../components/Link';
import { ErrorNote, Loading, PageTitle, formatTime, useAsync } from '../components/ui';
import { useLiveThread } from '../components/live';
import { RunView, MessageParts } from '../components/RunView';
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
  // Assistant turns render the full per-step trajectory (tool calls, results,
  // scratch, step boundaries) from the stored UIMessage parts — the same expanded
  // view as the live stream — so a turn keeps its display after the stream ends.
  // User messages stay as plain delivered text.
  const showParts = isSunny && m.parts != null && m.parts.length > 0;
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
        {isSunny && m.steps != null && (
          <span>
            · {m.steps} step{m.steps === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {showParts ? (
        <MessageParts parts={m.parts ?? []} />
      ) : m.delivered.length > 0 ? (
        <div className="text-fg">
          {m.delivered.map((text, i) => (
            <Markdown key={i}>{text}</Markdown>
          ))}
        </div>
      ) : (
        !m.scratch &&
        m.attachments.length === 0 && <div className="text-fg-dim italic">(silent turn)</div>
      )}
      {m.attachments.length > 0 && (
        <div className="mt-xs flex flex-wrap gap-sm">
          {m.attachments.map((a, i) =>
            a.kind === 'image' ? (
              <a key={i} href={a.src} target="_blank" rel="noreferrer">
                <img
                  src={a.src}
                  alt={a.name}
                  className="max-h-64 max-w-full rounded border border-border"
                />
              </a>
            ) : (
              <a
                key={i}
                href={a.src}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {a.name} ({a.mediaType})
              </a>
            ),
          )}
        </div>
      )}
      {!showParts && m.scratch && (
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
        ? apiGet<{ results: SearchHit[] }>(
            `/conversation/search?q=${encodeURIComponent(submitted)}`,
          )
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
                <LinkButton
                  onClick={() => navigate(`conversation/${encodeURIComponent(t.threadId)}`)}
                >
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

/** Floating "jump to latest" control — shown only when scrolled up from the bottom
 *  (the auto-stick-to-bottom affordance). */
function ScrollToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      onClick={() => void scrollToBottom()}
      className="absolute bottom-md left-1/2 -translate-x-1/2 rounded-full bg-border px-sm text-fg hover:text-primary"
    >
      ↓ latest
    </button>
  );
}

/** Nested thread page: breadcrumb, then the messages chronologically in a scroll
 *  region that auto-sticks to the bottom as the in-flight turn streams in (the
 *  newest message is always in view, with a jump-to-latest button when scrolled up). */
function ThreadPage({ threadId }: { threadId: string }) {
  const state = useAsync<ThreadDetail>(
    () => apiGet<ThreadDetail>(`/conversation/thread?id=${encodeURIComponent(threadId)}`),
    [threadId],
  );
  const reload = state.reload;
  const label = state.status === 'ready' ? state.data.label : '…';

  // Stream this thread live over one persistent SSE connection — whatever turn runs
  // now or next, with no run-id discovery and no polling gap (so a message sent
  // while the page is open starts streaming immediately).
  const { message, run, lastDoneRunId } = useLiveThread(threadId);
  const [settledRun, setSettledRun] = useState<string | null>(null);

  // Settle to the persisted record: when a turn finishes, refetch the thread (the
  // turn becomes a normal per-step bubble) and stop rendering the live trajectory.
  useEffect(() => {
    if (lastDoneRunId && lastDoneRunId !== settledRun) {
      setSettledRun(lastDoneRunId);
      reload();
    }
  }, [lastDoneRunId, settledRun, reload]);

  const showLive = run != null && message != null && settledRun !== run.runId;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-md font-bold text-fg">
        <Link to="conversation">Conversation</Link>
        <span className="font-normal text-fg-dim"> / {label}</span>
      </div>
      <StickToBottom className="relative min-h-0 flex-1" resize="smooth" initial="smooth">
        <StickToBottom.Content className="flex flex-col">
          {state.status === 'loading' && <Loading />}
          {state.status === 'error' && <ErrorNote error={state.error} />}
          {state.status === 'ready' && state.data.messages.length === 0 && !showLive && (
            <p className="text-fg-dim">No messages.</p>
          )}
          {state.status === 'ready' && state.data.messages.map((m) => <Bubble key={m.id} m={m} />)}
          {showLive && (
            <div className="mt-sm">
              <div className="mb-xs text-secondary">サニー · responding…</div>
              <RunView message={message} run={run} />
            </div>
          )}
        </StickToBottom.Content>
        <ScrollToLatest />
      </StickToBottom>
    </div>
  );
}

export function Conversation({ threadId }: { threadId: string | null }) {
  return threadId ? <ThreadPage threadId={threadId} /> : <ConversationIndex />;
}
