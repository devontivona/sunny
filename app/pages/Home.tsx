import { NAV } from '../components/Layout';
import { LinkButton } from '../components/Link';
import { navigate } from '../router';

// Home page (D-WD2): the menu as a vertical, enumerated index — a terminal
// directory listing. Each row is one baseline-grid line; entries are links.

const DESCRIPTIONS: Record<string, string> = {
  sunny: "Sunny's operating notes — how it behaves.",
  user: 'The durable model of the owner.',
  memory: 'INDEX + topic documents.',
  conversation: 'Recent messages, retained scratch, keyword search.',
  schedules: 'Schedules and their run history.',
  activity: 'Per-turn token / usage / cache metrics.',
  health: 'Service, database, scheduler, and gateway status.',
};

export function Home() {
  return (
    <div>
      <ul>
        {NAV.map((item, i) => (
          <li key={item.path} className="flex items-baseline gap-sm">
            <span className="tabular-nums text-fg-dim">{String(i + 1).padStart(2, '0')}</span>
            <LinkButton onClick={() => navigate(item.path)}>{item.label}</LinkButton>
            <span className="truncate text-fg-dim">{DESCRIPTIONS[item.path] ?? ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
