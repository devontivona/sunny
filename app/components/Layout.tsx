import type { ReactNode } from 'react';
import { href, navigate } from '../router';

// Shared layout (D-WD2): the サニー masthead on every page, plus a menu whose
// placement depends on depth — the home page renders a vertical enumerated index
// (see pages/Home.tsx), child pages get a horizontal, side-scrolling top bar.

export interface NavItem {
  path: string;
  label: string;
}

export const NAV: NavItem[] = [
  { path: 'sunny', label: 'SUNNY.md' },
  { path: 'user', label: 'USER.md' },
  { path: 'memory', label: 'memory' },
  { path: 'conversation', label: 'conversation' },
  { path: 'schedules', label: 'schedules' },
  { path: 'activity', label: 'activity & health' },
];

function Masthead() {
  return (
    <header className="border-b border-border bg-bg-dark/60">
      <div className="mx-auto flex max-w-[960px] items-baseline gap-md px-md py-md">
        <a
          href={href('')}
          className="text-masthead font-bold tracking-[0.15em] text-fg no-underline hover:text-primary"
          aria-label="home"
        >
          サニー
        </a>
        <span className="text-label-sm tracking-[0.1em] text-fg-dim">read-only dashboard</span>
      </div>
    </header>
  );
}

/** Horizontal, side-scrolling top menu for child pages (D-WD2). */
function TopMenu({ active }: { active: string }) {
  return (
    <nav className="border-b border-border bg-surface/40">
      <div className="mx-auto max-w-[960px] overflow-x-auto px-md">
        <ul className="flex min-w-max gap-xs py-sm">
          {NAV.map((item) => {
            const isActive = active === item.path || active.startsWith(`${item.path}/`);
            return (
              <li key={item.path}>
                <button
                  type="button"
                  onClick={() => navigate(item.path)}
                  className={[
                    'whitespace-nowrap rounded-sm px-sm py-xs text-label-md tracking-[0.06em] transition-colors',
                    isActive
                      ? 'bg-surface-elevated text-primary'
                      : 'text-fg-muted hover:bg-surface-elevated hover:text-fg',
                  ].join(' ')}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

export function Layout({
  home,
  active,
  children,
}: {
  home: boolean;
  active: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <Masthead />
      {!home && <TopMenu active={active} />}
      <main className="mx-auto max-w-[960px] px-md py-lg">{children}</main>
    </div>
  );
}
