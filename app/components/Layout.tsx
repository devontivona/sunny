import type { ReactNode } from 'react';
import { href, navigate } from '../router';
import { LinkButton } from './Link';

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
  { path: 'memory', label: 'Memory' },
  { path: 'conversation', label: 'Conversation' },
  { path: 'schedules', label: 'Schedules' },
  { path: 'activity', label: 'Activity' },
  { path: 'health', label: 'Health' },
];

function Masthead() {
  return (
    <header>
      <div className="mx-auto flex max-w-[900px] items-baseline gap-sm px-md py-sm">
        <a
          href={href('')}
          className="font-bold tracking-[0.2em] text-fg no-underline hover:text-primary"
          aria-label="home"
        >
          サニー
        </a>
      </div>
    </header>
  );
}

/**
 * A box drawn with TUI line-characters (┌─┐ │ └─┘) — the one place we "draw" a
 * border, with text, the way a terminal does. The top/bottom fills are a long run
 * of `─` clipped to width.
 */
function AsciiBox({ children }: { children: ReactNode }) {
  const fill = '─'.repeat(300);
  return (
    <div className="text-fg-dim">
      <div className="flex select-none">
        <span>┌</span>
        <span className="flex-1 overflow-hidden whitespace-nowrap">{fill}</span>
        <span>┐</span>
      </div>
      <div className="flex">
        <span className="select-none">│</span>
        <div className="min-w-0 flex-1 overflow-x-auto px-sm text-fg">{children}</div>
        <span className="select-none">│</span>
      </div>
      <div className="flex select-none">
        <span>└</span>
        <span className="flex-1 overflow-hidden whitespace-nowrap">{fill}</span>
        <span>┘</span>
      </div>
    </div>
  );
}

/** Horizontal, side-scrolling top menu for child pages (D-WD2). Items are links. */
function TopMenu({ active }: { active: string }) {
  return (
    <nav className="mx-auto max-w-[900px] px-md py-sm">
      <AsciiBox>
        <ul className="flex min-w-max gap-md">
          {NAV.map((item) => {
            const isActive = active === item.path || active.startsWith(`${item.path}/`);
            return (
              <li key={item.path} className="whitespace-nowrap">
                <LinkButton
                  active={isActive}
                  onClick={() => navigate(item.path)}
                  className={isActive ? 'text-primary' : 'text-fg-muted hover:text-primary'}
                >
                  {item.label}
                </LinkButton>
              </li>
            );
          })}
        </ul>
      </AsciiBox>
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
  // No forced `min-h-screen` (100vh): that mismatches the real viewport by a hair
  // (sub-pixel / scrollbar rounding) and produces a phantom scroll on pages that
  // fit. The page is exactly its content height — `body` paints `bg-bg` across the
  // whole viewport via background propagation, so short pages still look full.
  return (
    <div className="text-fg">
      <Masthead />
      {!home && <TopMenu active={active} />}
      <main className="mx-auto max-w-[900px] px-md py-md">{children}</main>
    </div>
  );
}
