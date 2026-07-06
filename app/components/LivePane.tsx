import { useEffect, type ReactNode } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';

// Shared live scroll pane (live-conversation-streaming): the auto-stick-to-bottom
// scroll region used by BOTH the Conversation thread and the background-job run view.
// Owns the streaming UX so it stays consistent across the two: smooth stick-to-
// bottom while content streams, a "↓ latest" jump button when scrolled up, no
// horizontal scroll (overflow-wrap:anywhere, inherited), and bottom padding so the
// last line clears the page edge.

/** Floating "jump to latest" control — shown only when scrolled up from the bottom. */
function ScrollToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      onClick={() => void scrollToBottom()}
      className="absolute bottom-md left-1/2 -translate-x-1/2 text-primary hover:underline"
    >
      ↓ latest
    </button>
  );
}

/** Keeps the view glued to the bottom as content streams. The library's resize
 *  heuristic can drop the lock when content churns, so we actively re-assert: jump
 *  to bottom on each new run, and follow every streamed chunk while the user is
 *  still at the bottom (if they scroll up we leave them — ↓ latest brings them back). */
function AutoStick({ runId, version }: { runId: string | null; version: number }) {
  const { scrollToBottom, isAtBottom } = useStickToBottomContext();
  useEffect(() => {
    if (runId) void scrollToBottom();
  }, [runId, scrollToBottom]);
  useEffect(() => {
    if (isAtBottom) void scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return null;
}

/**
 * A full-height pane with a pinned header and an auto-stick-to-bottom scroll region.
 * `runId` re-locks to the bottom on each new run; `version` is a per-chunk signal
 * that drives the follow-while-streaming behavior.
 */
export function LivePane({
  header,
  runId,
  version,
  children,
}: {
  header?: ReactNode;
  runId: string | null;
  version: number;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header && <div className="mb-md font-bold text-fg">{header}</div>}
      <StickToBottom className="relative min-h-0 flex-1" resize="smooth" initial="smooth">
        <AutoStick runId={runId} version={version} />
        <StickToBottom.Content className="flex flex-col pb-lg [overflow-wrap:anywhere]">
          {children}
        </StickToBottom.Content>
        <ScrollToLatest />
      </StickToBottom>
    </div>
  );
}
