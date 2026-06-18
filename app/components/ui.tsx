import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Unauthorized } from '../api';

// Small shared building blocks for the terminal UI + a fetch hook used by pages.

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: T };

/**
 * Run an async loader and track its state. Re-runs when `deps` change. Propagates
 * `Unauthorized` upward (rethrown) so the shell can flip to the pairing flow.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load()
      .then((data) => live && setState({ status: 'ready', data }))
      .catch((error: unknown) => {
        // A 401 means the session lapsed mid-use; tell the shell to re-pair
        // (rethrowing inside an async effect would just be swallowed by React).
        if (error instanceof Unauthorized) {
          window.dispatchEvent(new CustomEvent('dashboard:unauthorized'));
          return;
        }
        if (live) setState({ status: 'error', error: error as Error });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload };
}

/**
 * A full-viewport overlay for takeover screens (loading, unconfigured, the auth
 * gate). Pinned with `fixed inset-0` so it's out of document flow and exactly the
 * viewport box — the page can't grow past the screen and scroll. Content centers
 * when it fits and scrolls *within* the overlay only when taller than the viewport
 * (small screens).
 */
export function Takeover({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 overflow-y-auto bg-bg">
      <div className="flex min-h-full items-center justify-center p-md">{children}</div>
    </div>
  );
}

export function Loading({ label = 'loading…' }: { label?: string }) {
  return <div className="text-fg-dim">{label}</div>;
}

export function ErrorNote({ error }: { error: Error }) {
  return <div className="my-sm text-error">! error: {error.message}</div>;
}

/**
 * A titled region drawn TUI-style: an UPPERCASE dim label and the content below —
 * no card, no border, no rule, no shadow (a terminal has no lines; DESIGN.md).
 * Hierarchy is the dim label + whole-row spacing.
 */
export function Panel({
  title,
  children,
  right,
}: {
  title?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="mb-md">
      {(title || right) && (
        <div className="flex items-center justify-between gap-sm">
          {title && <span className="text-fg-dim">{title}</span>}
          {right}
        </div>
      )}
      <div className="pt-sm">{children}</div>
    </section>
  );
}

/** Page heading printed like a terminal section line: a bold Title-Case heading. */
export function PageTitle({ children }: { children: ReactNode }) {
  return <div className="mb-md font-bold text-fg">{children}</div>;
}

export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={[
        'inline-block size-[10px] rounded-full',
        ok ? 'bg-success' : 'bg-error',
      ].join(' ')}
      aria-label={ok ? 'ok' : 'down'}
    />
  );
}

/** Human-readable relative-ish timestamp. */
export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
