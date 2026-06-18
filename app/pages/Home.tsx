import { NAV } from '../components/Layout';
import { navigate } from '../router';

// Home page (D-WD2): the menu as a vertical, enumerated index — a terminal
// directory listing. Child pages get the horizontal bar instead.

const DESCRIPTIONS: Record<string, string> = {
  sunny: "Sunny's operating notes — how it behaves.",
  user: 'The durable model of the owner.',
  memory: 'INDEX + topic documents.',
  conversation: 'Recent messages, retained scratch, keyword search.',
  schedules: 'Schedules and their run history.',
  activity: 'Per-turn token/usage metrics + service health.',
};

export function Home() {
  return (
    <div>
      <p className="mb-lg text-body-md text-fg-muted">
        A read-only window into Sunny's internals. Pick a view:
      </p>
      <ol className="space-y-xs">
        {NAV.map((item, i) => (
          <li key={item.path}>
            <button
              type="button"
              onClick={() => navigate(item.path)}
              className="group flex w-full items-baseline gap-md rounded-sm px-sm py-sm text-left hover:bg-surface-elevated"
            >
              <span className="text-label-md tabular-nums text-fg-dim">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="text-body-lg text-primary group-hover:underline">{item.label}</span>
              <span className="text-body-sm text-fg-dim">{DESCRIPTIONS[item.path] ?? ''}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
