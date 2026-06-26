import type { UIMessage } from 'ai';
import { Markdown } from './Markdown';
import { useNow } from './live';
import type { LiveRun } from '../types';

// Shared live run view (live-conversation-streaming): renders a streaming
// `UIMessage` as a trajectory — model scratch/thinking, each tool call with its
// arguments and result/error, and step boundaries — under a status bar (status,
// elapsed, steps, live token usage, model/effort). Reused by the Conversation
// in-flight turn and the running-job view. Strictly observe-only: no controls.

type AnyPart = UIMessage['parts'][number];

interface ToolPartShape {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function preview(v: unknown, max = 280): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function elapsedLabel(startISO: string, now: number): string {
  const ms = Math.max(0, now - new Date(startISO).getTime());
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function StatusBadge({ status }: { status: LiveRun['status'] }) {
  const color =
    status === 'running' ? 'text-warning' : status === 'errored' ? 'text-error' : 'text-success';
  const label = status === 'running' ? '● live' : status === 'errored' ? '✗ errored' : '✓ done';
  return <span className={color}>{label}</span>;
}

function StatusBar({ run }: { run: LiveRun }) {
  const now = useNow(run.status === 'running');
  const u = run.usage;
  return (
    <div className="mb-sm flex flex-wrap items-baseline gap-x-md gap-y-xs text-fg-dim">
      <StatusBadge status={run.status} />
      <span>{elapsedLabel(run.startedAt, now)}</span>
      <span>
        {run.steps} step{run.steps === 1 ? '' : 's'}
      </span>
      {u && (u.in != null || u.out != null) && (
        <span>
          {u.in ?? 0}↑ {u.out ?? 0}↓
          {u.cached != null && u.cached > 0 ? ` · ${u.cached} cached` : ''}
          {u.cacheWrite != null && u.cacheWrite > 0 ? ` · ${u.cacheWrite} written` : ''}
        </span>
      )}
      {run.model && (
        <span>
          {run.model}
          {run.effort ? ` · ${run.effort}` : ''}
        </span>
      )}
      {run.traceUrl && (
        <a
          href={run.traceUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          trace
        </a>
      )}
    </div>
  );
}

function ToolPart({ part }: { part: ToolPartShape }) {
  const name = part.toolName ?? (part.type.startsWith('tool-') ? part.type.slice(5) : part.type);
  const state = part.state ?? '';
  const stateColor =
    state === 'output-error'
      ? 'text-error'
      : state.startsWith('input')
        ? 'text-fg-dim'
        : 'text-secondary';
  return (
    <div className="my-xs">
      <div className="flex items-baseline gap-sm">
        <span className="text-primary">▸ {name}</span>
        {state && <span className={stateColor}>[{state}]</span>}
      </div>
      {part.input != null && preview(part.input) !== '{}' && (
        <div className="pl-md text-fg-muted">{preview(part.input)}</div>
      )}
      {part.state === 'output-error' ? (
        <div className="pl-md text-error">✗ {preview(part.errorText)}</div>
      ) : (
        part.output != null && <div className="pl-md text-fg-dim">→ {preview(part.output)}</div>
      )}
    </div>
  );
}

/** Render a list of `UIMessagePart`s as a trajectory. Shared by the live stream
 *  (`RunView`) and persisted turns (`Bubble`) so both show the same expanded view. */
export function MessageParts({ parts }: { parts: readonly AnyPart[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <Part key={i} part={part} />
      ))}
    </>
  );
}

function Part({ part }: { part: AnyPart }) {
  if (part.type === 'text') {
    return part.text.trim() ? (
      <div className="my-xs text-fg-muted">
        <Markdown>{part.text}</Markdown>
      </div>
    ) : null;
  }
  if (part.type === 'reasoning') {
    return part.text.trim() ? (
      <div className="my-xs text-fg-dim italic">
        <Markdown>{part.text}</Markdown>
      </div>
    ) : null;
  }
  if (part.type === 'step-start') {
    return <div className="my-sm border-t border-border" aria-hidden />;
  }
  if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
    return <ToolPart part={part as unknown as ToolPartShape} />;
  }
  return null;
}

export function RunView({ message, run }: { message: UIMessage | null; run: LiveRun | null }) {
  return (
    <div>
      {run && <StatusBar run={run} />}
      {message && message.parts.length > 0 ? (
        <MessageParts parts={message.parts} />
      ) : (
        <div className="text-fg-dim italic">waiting for activity…</div>
      )}
    </div>
  );
}
