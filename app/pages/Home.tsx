import { NAV } from '../components/Layout';
import { LinkButton } from '../components/Link';
import { navigate } from '../router';

// Home page (D-WD2): the menu as a vertical, enumerated index — a terminal
// directory listing. Each row is one baseline-grid line; entries are links.

export function Home() {
  return (
    <div>
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
