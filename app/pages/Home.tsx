import { NAV } from '../components/Layout';
import { Link, LinkButton } from '../components/Link';
import { navigate } from '../router';
import { useActiveRuns } from '../components/live';
import type { LiveRun } from '../types';

// Home page (D-WD2): the menu as a vertical, enumerated index — a terminal
// directory listing. Each row is one baseline-grid line; entries are links.
//
// Above the menu, an "active now" indicator (live-conversation-streaming) surfaces
// any in-flight turn or running job with a shortcut straight to its live view. It is
// absent when nothing is running, and never links to a run that isn't active.

function runHref(r: LiveRun): string {
  return r.kind === 'turn' && r.threadId
    ? `conversation/${encodeURIComponent(r.threadId)}`
    : `jobs/${encodeURIComponent(r.runId)}`;
}

function ActiveNow() {
  const live = useActiveRuns().filter((r) => r.status === 'running');
  if (live.length === 0) return null;
  // Each active run is a real hyperlink (not a button) straight to its live view —
  // unambiguously clickable, cmd-clickable, and independent of any JS handler.
  return (
    <div className="mb-md">
      <div className="text-warning">● Sunny is active now</div>
      <ul className="mt-xs">
        {live.map((r) => (
          <li key={r.runId}>
            <Link to={runHref(r)} className="text-primary hover:underline">
              → {r.kind === 'turn' ? 'conversation' : 'job'} · {r.label} (live)
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Home() {
  return (
    <div>
      <ActiveNow />
      <ul>
        {NAV.map((item, i) => (
          <li key={item.path} className="flex items-baseline gap-sm">
            <span className="tabular-nums text-fg-dim">{String(i + 1).padStart(2, '0')}</span>
            <LinkButton onClick={() => navigate(item.path)}>{item.label}</LinkButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
