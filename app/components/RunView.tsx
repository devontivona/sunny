import type { ReactNode } from 'react';
import type { UIMessage } from 'ai';
import { Dialog } from '@base-ui/react/dialog';
import { Markdown } from './Markdown';
import { useNow } from './live';
import type { LiveRun } from '../types';

// Shared live run view (live-conversation-streaming): renders a `UIMessage` as a
// trajectory — model scratch/thinking, each tool call (full args/result behind a
// drawer so they don't clog the thread), and the delivered messages — under a
// status bar. Reused by the Conversation in-flight turn and the running-job view.
// Strictly observe-only: no controls. No rules/dividers (terminal aesthetic).

type AnyPart = UIMessage['parts'][number];

interface ToolPartShape {
  type: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

/** Pretty-print a value as formatted JSON; if it's a JSON-encoded string, parse it
 *  first so nested payloads read cleanly. Falls back to the raw string. */
function pretty(v: unknown): string {
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Compact one-line preview for an inline hint (full value lives in the drawer). */
function preview(v: unknown, max = 120): string {
  const s = (
    typeof v === 'string'
      ? v
      : (() => {
          try {
            return JSON.stringify(v) ?? String(v);
          } catch {
            return String(v);
          }
        })()
  )
    .replace(/\s+/g, ' ')
    .trim();
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
      {/* Elapsed only makes sense for a live run; for a finished/historical run
          `now - startedAt` would be misleading (e.g. hours later). */}
      {run.status === 'running' && <span>{elapsedLabel(run.startedAt, now)}</span>}
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

interface DrawerSection {
  label: string;
  body: string;
}

/** A right-side slide-over (Base UI Dialog) that holds the full, pretty-printed
 *  payload for a tool call, so the thread stays uncluttered. */
function DetailDrawer({
  trigger,
  title,
  sections,
}: {
  trigger: ReactNode;
  title: string;
  sections: DrawerSection[];
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="text-primary hover:underline">{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed right-0 top-0 z-10 flex h-dvh w-full max-w-[680px] flex-col bg-bg p-md transition-transform duration-200 ease-out data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full">
          <div className="mb-sm flex items-baseline justify-between gap-md">
            <Dialog.Title className="font-bold text-secondary">{title}</Dialog.Title>
            <Dialog.Close className="text-primary hover:underline">close ✕</Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sections.map((s) => (
              <div key={s.label} className="mb-md">
                <div className="mb-xs text-fg-dim">{s.label}</div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words text-fg-muted">
                  {s.body}
                </pre>
              </div>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ToolPart({ part }: { part: ToolPartShape }) {
  const name = part.toolName ?? (part.type.startsWith('tool-') ? part.type.slice(5) : part.type);

  // The delivered message: render the text as the conversation bubble itself, not
  // as a tool call — it IS Sunny speaking. (Whether the turn was recovered/de-poisoned
  // is a turn-level signal shown as [R] on the bubble header, not here.)
  if (name === 'send_message') {
    const text = (part.input as { text?: string } | undefined)?.text;
    return text ? (
      <div className="my-xs text-fg">
        <Markdown>{text}</Markdown>
      </div>
    ) : null;
  }

  const isError = part.state === 'output-error';
  const sections: DrawerSection[] = [];
  if (part.input != null) sections.push({ label: 'Input', body: pretty(part.input) });
  if (part.output != null) sections.push({ label: 'Output', body: pretty(part.output) });
  if (part.errorText) sections.push({ label: 'Error', body: String(part.errorText) });

  return (
    <div className="my-xs">
      <div className="flex items-baseline gap-sm">
        <span className="text-secondary">{name}</span>
        {isError && <span className="text-error">errored</span>}
        {sections.length > 0 && (
          <DetailDrawer trigger={<>[&nbsp;details&nbsp;]</>} title={name} sections={sections} />
        )}
      </div>
      {part.input != null && preview(part.input) !== '{}' && (
        <div className="truncate pl-md text-fg-dim">{preview(part.input)}</div>
      )}
    </div>
  );
}

/** Render a list of `UIMessagePart`s as a trajectory, in chronological order.
 *  Shared by the live stream (`RunView`) and persisted turns (`Bubble`). */
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
  // Regular model output (scratch) and reasoning are Sunny's private working text,
  // not the delivered message — dim them so the delivered `send_message` (rendered
  // at full prominence by ToolPart) clearly stands out. Opacity dims regardless of
  // the markdown renderer's own element colors.
  if (part.type === 'text') {
    return part.text.trim() ? (
      <div className="my-xs opacity-60">
        <Markdown>{part.text}</Markdown>
      </div>
    ) : null;
  }
  if (part.type === 'reasoning') {
    return part.text.trim() ? (
      <div className="my-xs italic opacity-50">
        <Markdown>{part.text}</Markdown>
      </div>
    ) : null;
  }
  if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
    return <ToolPart part={part as unknown as ToolPartShape} />;
  }
  // step-start and other markers render nothing (no rules — terminal aesthetic).
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
