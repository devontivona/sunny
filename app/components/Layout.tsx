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
  { path: 'mcp', label: 'MCP servers' },
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
  // Full-viewport flex column: a pinned masthead and a single scroll region below
  // it. This lets a page (e.g. the live Conversation) own a bottom-anchored
  // scroll container that sticks to the newest message, while ordinary pages just
  // scroll normally inside `main`.
  return (
    <div className="flex h-dvh flex-col text-fg">
      <Masthead />
      <main className="mx-auto flex w-full max-w-[900px] min-h-0 flex-1 flex-col overflow-y-auto px-md py-md">
        {children}
      </main>
    </div>
  );
}
