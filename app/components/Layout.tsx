import type { ReactNode } from 'react';
import { href } from '../router';

// Shared layout (D-WD2): the サニー masthead is on every page and links back to
// the home index — which IS the menu. There's no separate per-page nav.

export interface NavItem {
  path: string;
  label: string;
}

export const NAV: NavItem[] = [
  { path: 'sunny', label: 'SUNNY.md' },
  { path: 'user', label: 'USER.md' },
  { path: 'memory', label: 'Memory' },
  { path: 'tools', label: 'Tools' },
  { path: 'credentials', label: 'Credentials' },
  { path: 'skills', label: 'Skills' },
  { path: 'conversation', label: 'Conversation' },
  { path: 'schedules', label: 'Schedules' },
  { path: 'jobs', label: 'Jobs' },
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
          aria-label="home / menu"
          title="home / menu"
        >
          サニー
        </a>
      </div>
    </header>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  // No forced `min-h-screen` (100vh): that mismatches the real viewport by a hair
  // (sub-pixel / scrollbar rounding) and produces a phantom scroll on pages that
  // fit. The page is exactly its content height — `body` paints `bg-bg` across the
  // whole viewport via background propagation, so short pages still look full.
  return (
    <div className="text-fg">
      <Masthead />
      <main className="mx-auto max-w-[900px] px-md py-md">{children}</main>
    </div>
  );
}
